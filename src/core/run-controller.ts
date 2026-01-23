import { relative } from 'node:path';

import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import { executePlan } from '../agent/executor';
import { type Plan, planSchema } from '../agent/schemas';
import type { SessionPool } from '../agent/session';
import { suggestVerificationRecovery } from '../ai/cognition/assist';
import { generateCiFixPlan } from '../ai/cognition/ci-triager';
import { generateExecutionKickoffPrompt } from '../ai/cognition/kickoff';
import { generatePlan } from '../ai/cognition/planner';
import { draftPullRequest } from '../ai/cognition/pr-writer';
import { generateRecoveryPlan } from '../ai/cognition/recovery';
import { classifyReviewThreads } from '../ai/cognition/review-classifier';
import { generateReviewRemediationKickoffPrompt } from '../ai/cognition/review-kickoff';
import { generateReviewFixPlan } from '../ai/cognition/reviewer';
import { generateVerificationFixPlan } from '../ai/cognition/verification-fix';
import { decideVerification } from '../ai/cognition/verifier';
import { createConversationStore } from '../ai/conversation';
import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import { createEnvelope, type EmitContext, toEventError } from '../events/emit';
import type { Phase, RunPhaseChanged, RunStep } from '../events/schema';
import { runGit } from '../git/exec';
import { waitForCi } from '../github/ci';
import { openOrUpdatePr, requestReviewers } from '../github/pr';
import {
  fetchReviewResponses,
  fetchReviewThreadById,
  fetchUnresolvedReviewComments,
  replyToReviewComment,
  resolveReviewThread,
} from '../github/review';
import {
  evaluateLearningTargets,
  loadLearningHistory,
  scoreLearningConfidence,
} from '../learning/auto-apply';
import {
  applyLearningNotes,
  generateLearningNotes,
  renderLearningMarkdown,
} from '../learning/notes';
import { hashPrompt, renderPromptSummary } from '../prompts';
import { runAiReviewer } from '../review/ai-reviewer';
import {
  applySeverityPolicy,
  buildReviewPriorityList,
  buildSeverityIndex,
  buildSeveritySummary,
} from '../review/intelligence';
import { formatLocalGateSummary, generateLocalGateReport } from '../review/local-gate';
import {
  buildReviewPlanThreads,
  type ReviewThreadFingerprint,
  selectThreadsForContext,
} from '../review/planning';
import { suggestReviewers } from '../review/reviewer-suggestions';
import { type ArtifactEntry, readArtifact, writeArtifact } from '../state/artifacts';
import { type LearningRequest, writeLearningRequest } from '../state/learning';
import {
  readReviewerStats,
  recordReviewerRequests,
  recordReviewerResponses,
} from '../state/reviewers';
import {
  commentOnPrOpen,
  completeTask,
  moveTaskToInProgress,
  moveTaskToInReview,
} from '../task/lifecycle';
import { resolveTask } from '../task/resolve';
import type { Task } from '../task/types';
import { hashString } from '../utils/hash';
import { shouldAttemptVerificationAutoFix } from '../verify/auto-fix';
import { runVerifyCommands, type VerifyResult } from '../verify/run';
import { triageVerificationFailures } from '../verify/triage';
import type { RunContext } from './context';
import { SilvanError } from './errors';
import { createLogger } from './logger';

type RunControllerOptions = {
  taskRef?: string;
  task?: Task;
  worktreeName?: string;
  clarifications?: Record<string, string>;
  allowMissingClarifications?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  dangerous?: boolean;
  sessions?: SessionPool;
};

type RunStatus = 'running' | 'canceled' | 'failed' | 'success';

type RunMeta = {
  version: '1.0.0';
  status: RunStatus;
  phase: Phase;
  step?: string;
  attempt: number;
  updatedAt: string;
};

type StepStatus = 'not_started' | 'running' | 'done' | 'failed';

type StepRecord = {
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
  inputsDigest?: string;
  outputsDigest?: string;
  artifacts?: Record<string, ArtifactEntry>;
  error?: ReturnType<typeof toEventError>;
  lease?: { leaseId: string; startedAt: string; heartbeatAt: string };
};

type RunStateData = Record<string, unknown> & {
  run?: RunMeta;
  steps?: Record<string, StepRecord>;
  artifactsIndex?: Record<string, Record<string, ArtifactEntry>>;
};

const leaseStaleMs = 2 * 60 * 1000;

type ModelPhase = 'plan' | 'execute' | 'review' | 'pr' | 'recovery' | 'verify';

function getModelForPhase(config: RunContext['config'], phase: ModelPhase): string {
  const models = config.ai.models;
  return models[phase] ?? models.default ?? 'claude-sonnet-4-5-20250929';
}

function getBudgetsForPhase(
  config: RunContext['config'],
  phase: ModelPhase,
): {
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
} {
  const defaults = config.ai.budgets.default;
  const phaseBudget = config.ai.budgets[phase];
  const maxTurns = phaseBudget.maxTurns ?? defaults.maxTurns;
  const maxBudgetUsd = phaseBudget.maxBudgetUsd ?? defaults.maxBudgetUsd;
  const maxThinkingTokens = phaseBudget.maxThinkingTokens ?? defaults.maxThinkingTokens;
  return {
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(maxThinkingTokens !== undefined ? { maxThinkingTokens } : {}),
  };
}

type VerificationAssistSummary = {
  summary?: string;
  steps?: string[];
  context: 'verify' | 'review' | 'ci_fix' | 'recovery';
  commands: string[];
};

type VerificationAutoFixSummary = {
  context: VerificationAssistSummary['context'];
  attempts: number;
  maxAttempts: number;
  status: 'skipped' | 'planned' | 'applied' | 'succeeded' | 'failed';
  reason?: string;
  fixSummary?: string;
  planSummary?: string;
  planSteps?: number;
  diffBefore?: string;
  diffAfter?: string;
  verificationOk?: boolean;
  lastAttemptAt?: string;
};

function formatVerificationBlockedReason(
  context: VerificationAssistSummary['context'],
  summary?: string,
): string {
  const prefix =
    context === 'review'
      ? 'Verification failed during review.'
      : context === 'ci_fix'
        ? 'Verification failed during CI fix.'
        : context === 'recovery'
          ? 'Verification failed during recovery.'
          : 'Verification failed.';
  return summary ? `${prefix} ${summary}` : prefix;
}

async function recordVerificationAssist(options: {
  ctx: RunContext;
  report: VerifyResult;
  context: VerificationAssistSummary['context'];
  emitContext: EmitContext;
}): Promise<void> {
  if (options.report.ok) return;
  const failures = options.report.results.filter((result) => result.exitCode !== 0);
  if (failures.length === 0) return;

  let assist: Awaited<ReturnType<typeof suggestVerificationRecovery>> | null = null;
  try {
    assist = await suggestVerificationRecovery({
      report: {
        results: failures.map((result) => ({
          name: result.name,
          exitCode: result.exitCode,
          stderr: result.stderr,
        })),
      },
      config: options.ctx.config,
      repoRoot: options.ctx.repo.repoRoot,
      cacheDir: options.ctx.state.cacheDir,
      bus: options.ctx.events.bus,
      context: options.emitContext,
    });
  } catch {
    assist = null;
  }

  if (!assist) return;

  const commands = failures.map((result) => result.name);
  await updateState(options.ctx, (data) => {
    const summary =
      typeof data['summary'] === 'object' && data['summary']
        ? (data['summary'] as Record<string, unknown>)
        : {};
    const blockedReason =
      typeof summary['blockedReason'] === 'string' ? summary['blockedReason'] : undefined;

    const verificationAssistSummary: VerificationAssistSummary = {
      context: options.context,
      commands,
      ...(assist.summary ? { summary: assist.summary } : {}),
      ...(assist.steps.length > 0 ? { steps: assist.steps } : {}),
    };

    return {
      ...data,
      verificationAssistSummary,
      summary: {
        ...summary,
        ...(blockedReason
          ? {}
          : {
              blockedReason: formatVerificationBlockedReason(
                options.context,
                assist.summary,
              ),
            }),
      },
    };
  });
}

function getVerificationAutoFixAttempts(data: Record<string, unknown>): number {
  const summary =
    typeof data['verificationAutoFixSummary'] === 'object' &&
    data['verificationAutoFixSummary']
      ? (data['verificationAutoFixSummary'] as VerificationAutoFixSummary)
      : undefined;
  return typeof summary?.attempts === 'number' ? summary.attempts : 0;
}

async function recordVerificationAutoFixSummary(
  ctx: RunContext,
  update: VerificationAutoFixSummary,
): Promise<void> {
  await updateState(ctx, (data) => ({
    ...data,
    verificationAutoFixSummary: update,
  }));
}

async function attemptVerificationAutoFix(options: {
  ctx: RunContext;
  emitContext: EmitContext;
  conversationStore: ReturnType<typeof createConversationStore>;
  worktreeRoot: string;
  failures: Array<{ name: string; exitCode: number; stderr: string }>;
  triageClassified: boolean;
  controllerOptions: RunControllerOptions;
  context: VerificationAssistSummary['context'];
}): Promise<{ resolved: boolean; report?: VerifyResult }> {
  const state = await options.ctx.state.readRunState(options.ctx.runId);
  const data = getRunState((state?.data as Record<string, unknown>) ?? {});
  const autoFixConfig = options.ctx.config.verify.autoFix;
  const attempts = getVerificationAutoFixAttempts(data);
  const decision = shouldAttemptVerificationAutoFix({
    enabled: autoFixConfig.enabled,
    maxAttempts: autoFixConfig.maxAttempts,
    attempts,
    classified: options.triageClassified,
    apply: Boolean(options.controllerOptions.apply),
    dryRun: Boolean(options.controllerOptions.dryRun),
  });

  if (!decision.attempt || options.failures.length === 0) {
    await recordVerificationAutoFixSummary(options.ctx, {
      context: options.context,
      attempts,
      maxAttempts: autoFixConfig.maxAttempts,
      status: 'skipped',
      ...(options.failures.length === 0
        ? { reason: 'no_failures' }
        : decision.reason
          ? { reason: decision.reason }
          : {}),
      lastAttemptAt: new Date().toISOString(),
    });
    return { resolved: false };
  }

  const commandLookup = new Map(
    options.ctx.config.verify.commands.map((command) => [command.name, command.cmd]),
  );
  const failures = options.failures.map((failure) => {
    const command = commandLookup.get(failure.name);
    return command ? { ...failure, command } : { ...failure };
  });

  const nextAttempt = attempts + 1;
  let fixPlan: Plan | undefined;
  try {
    fixPlan = await runStep(
      options.ctx,
      'verify.autofix.plan',
      'Plan verification fixes',
      () =>
        generateVerificationFixPlan({
          failures,
          store: options.conversationStore,
          config: options.ctx.config,
          ...(options.ctx.events.bus ? { bus: options.ctx.events.bus } : {}),
          context: options.emitContext,
        }),
      {
        inputs: { failures: failures.map((failure) => failure.name) },
        artifacts: (result) => ({ plan: result }),
      },
    );
  } catch {
    await recordVerificationAutoFixSummary(options.ctx, {
      context: options.context,
      attempts: nextAttempt,
      maxAttempts: autoFixConfig.maxAttempts,
      status: 'failed',
      reason: 'plan_failed',
      lastAttemptAt: new Date().toISOString(),
    });
    return { resolved: false };
  }
  if (!fixPlan) {
    return { resolved: false };
  }

  await recordVerificationAutoFixSummary(options.ctx, {
    context: options.context,
    attempts: nextAttempt,
    maxAttempts: autoFixConfig.maxAttempts,
    status: 'planned',
    planSummary: fixPlan.summary,
    planSteps: fixPlan.steps.length,
    lastAttemptAt: new Date().toISOString(),
  });

  const diffBefore = await runGit(['diff', '--stat'], {
    cwd: options.worktreeRoot,
    context: { runId: options.ctx.runId, repoRoot: options.ctx.repo.repoRoot },
  });

  const execModel = getModelForPhase(options.ctx.config, 'verify');
  const execBudgets = getBudgetsForPhase(options.ctx.config, 'verify');
  const planDigest = hashString(JSON.stringify(fixPlan));
  const logger = createLogger({
    bus: options.ctx.events.bus,
    context: options.emitContext,
    source: 'engine',
  });

  let fixSummary: string | undefined;
  try {
    fixSummary = await runStep(
      options.ctx,
      'verify.autofix.apply',
      'Apply verification fixes',
      async () => {
        const execPrompt = new ProseWriter();
        execPrompt.write('You are the implementation agent for Silvan.');
        execPrompt.write('Follow the plan step-by-step, using tools when needed.');
        execPrompt.write('Do not invent file contents; use fs.read before edits.');
        execPrompt.write('Keep changes minimal and aligned to the plan.');
        execPrompt.write('Use silvan.plan.read to fetch the full plan before edits.');
        execPrompt.write('Return a brief summary of changes.');
        execPrompt.write(`Plan digest: ${planDigest}`);

        const execSnapshot = await options.conversationStore.append({
          role: 'system',
          content: execPrompt.toString().trimEnd(),
          metadata: { kind: 'verification' },
        });

        const result = await executePlan({
          snapshot: execSnapshot,
          model: execModel,
          repoRoot: options.worktreeRoot,
          config: options.ctx.config,
          dryRun: Boolean(options.controllerOptions.dryRun),
          allowDestructive: Boolean(options.controllerOptions.apply),
          allowDangerous: Boolean(options.controllerOptions.dangerous),
          ...execBudgets,
          ...getToolBudget(options.ctx.config),
          ...(options.controllerOptions.sessions
            ? { sessionPool: options.controllerOptions.sessions }
            : {}),
          bus: options.ctx.events.bus,
          context: options.emitContext,
          state: options.ctx.state,
          heartbeat: () => heartbeatStep(options.ctx, 'verify.autofix.apply'),
        });

        const execConversation = appendMessages(execSnapshot.conversation, {
          role: 'assistant',
          content: `Verification fix summary: ${result}`,
          metadata: { kind: 'verification', protected: true },
        });
        await options.conversationStore.save(execConversation);
        return result;
      },
      {
        inputs: { planDigest },
        artifacts: (result) => ({ summary: result }),
      },
    );
  } catch {
    await recordVerificationAutoFixSummary(options.ctx, {
      context: options.context,
      attempts: nextAttempt,
      maxAttempts: autoFixConfig.maxAttempts,
      status: 'failed',
      reason: 'apply_failed',
      lastAttemptAt: new Date().toISOString(),
    });
    await logger.warn('Verification auto-fix failed to apply.');
    return { resolved: false };
  }

  const diffAfter = await runGit(['diff', '--stat'], {
    cwd: options.worktreeRoot,
    context: { runId: options.ctx.runId, repoRoot: options.ctx.repo.repoRoot },
  });
  const diffBeforeText = diffBefore.stdout.trim();
  const diffAfterText = diffAfter.stdout.trim();
  const beforeText = diffBeforeText.length > 0 ? diffBeforeText : 'No changes detected.';
  const afterText = diffAfterText.length > 0 ? diffAfterText : 'No changes detected.';
  await logger.info(
    `Verification auto-fix diff preview (before):\n${beforeText}\nAfter:\n${afterText}`,
  );

  await recordVerificationAutoFixSummary(options.ctx, {
    context: options.context,
    attempts: nextAttempt,
    maxAttempts: autoFixConfig.maxAttempts,
    status: 'applied',
    planSummary: fixPlan.summary,
    planSteps: fixPlan.steps.length,
    ...(fixSummary ? { fixSummary } : {}),
    ...(diffBeforeText ? { diffBefore: diffBeforeText } : {}),
    ...(diffAfterText ? { diffAfter: diffAfterText } : {}),
    lastAttemptAt: new Date().toISOString(),
  });

  const verifyReport = await runStep(
    options.ctx,
    'verify.autofix.verify',
    'Re-run verification',
    () => runVerifyCommands(options.ctx.config, { cwd: options.worktreeRoot }),
    { artifacts: (report) => ({ report }) },
  );

  await updateState(options.ctx, (prev) => {
    const summary =
      typeof prev['summary'] === 'object' && prev['summary']
        ? { ...(prev['summary'] as Record<string, unknown>) }
        : {};
    if (verifyReport.ok) {
      delete summary['blockedReason'];
    }
    return {
      ...prev,
      summary,
      verifySummary: {
        ok: verifyReport.ok,
        lastRunAt: new Date().toISOString(),
      },
      verificationAutoFixSummary: {
        context: options.context,
        attempts: nextAttempt,
        maxAttempts: autoFixConfig.maxAttempts,
        status: verifyReport.ok ? 'succeeded' : 'failed',
        planSummary: fixPlan.summary,
        planSteps: fixPlan.steps.length,
        ...(fixSummary ? { fixSummary } : {}),
        ...(diffBeforeText ? { diffBefore: diffBeforeText } : {}),
        ...(diffAfterText ? { diffAfter: diffAfterText } : {}),
        verificationOk: verifyReport.ok,
        lastAttemptAt: new Date().toISOString(),
      },
    };
  });

  return { resolved: verifyReport.ok, report: verifyReport };
}

function getToolBudget(config: RunContext['config']): {
  toolBudget?: { maxCalls?: number; maxDurationMs?: number };
} {
  const limits = config.ai.toolLimits;
  if (!limits.maxCalls && !limits.maxDurationMs) {
    return {};
  }
  return {
    toolBudget: {
      ...(limits.maxCalls ? { maxCalls: limits.maxCalls } : {}),
      ...(limits.maxDurationMs ? { maxDurationMs: limits.maxDurationMs } : {}),
    },
  };
}

function getRunState(data: Record<string, unknown>): RunStateData {
  return data as RunStateData;
}

function getStepRecord(data: RunStateData, stepId: string): StepRecord | undefined {
  return data.steps?.[stepId];
}

function getArtifactEntry(
  data: RunStateData,
  stepId: string,
  name: string,
): ArtifactEntry | undefined {
  const index = data.artifactsIndex ?? {};
  return index[stepId]?.[name];
}

async function storeArtifacts(
  ctx: RunContext,
  stepId: string,
  artifacts?: Record<string, unknown>,
): Promise<Record<string, ArtifactEntry> | undefined> {
  if (!artifacts || Object.keys(artifacts).length === 0) return undefined;
  const entries: Record<string, ArtifactEntry> = {};
  for (const [name, data] of Object.entries(artifacts)) {
    const entry = await writeArtifact({
      state: ctx.state,
      runId: ctx.runId,
      stepId,
      name,
      data,
    });
    entries[name] = entry;
  }
  return entries;
}

async function recordArtifacts(
  ctx: RunContext,
  stepId: string,
  artifacts?: Record<string, unknown>,
): Promise<Record<string, ArtifactEntry> | undefined> {
  const entries = await storeArtifacts(ctx, stepId, artifacts);
  if (!entries) return undefined;
  await updateState(ctx, (prev) => {
    const artifactsIndex =
      (prev['artifactsIndex'] as
        | Record<string, Record<string, ArtifactEntry>>
        | undefined) ?? {};
    return {
      ...prev,
      artifactsIndex: {
        ...artifactsIndex,
        [stepId]: {
          ...(artifactsIndex[stepId] ?? {}),
          ...entries,
        },
      },
    };
  });
  return entries;
}

function isLeaseStale(lease?: StepRecord['lease']): boolean {
  if (!lease?.heartbeatAt) return false;
  const last = new Date(lease.heartbeatAt).getTime();
  return Date.now() - last > leaseStaleMs;
}

function reviewRequestKey(options: {
  prNumber: number;
  reviewers: string[];
  requestCopilot: boolean;
}): string {
  return hashString(
    JSON.stringify({
      prNumber: options.prNumber,
      reviewers: [...options.reviewers].sort(),
      requestCopilot: options.requestCopilot,
    }),
  );
}

async function createCheckpointCommit(
  ctx: RunContext,
  message: string,
): Promise<{ committed: boolean; sha?: string }> {
  const worktreeRoot = ctx.repo.worktreePath ?? ctx.repo.repoRoot;
  await runGit(['add', '-A'], {
    cwd: worktreeRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
  });

  const diff = await runGit(['diff', '--cached', '--quiet'], {
    cwd: worktreeRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
  });

  if (diff.exitCode === 0) {
    return { committed: false };
  }

  const commit = await runGit(['commit', '-m', message], {
    cwd: worktreeRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
  });

  if (commit.exitCode !== 0) {
    throw new Error(commit.stderr || 'Failed to create checkpoint commit');
  }

  const shaResult = await runGit(['rev-parse', 'HEAD'], {
    cwd: worktreeRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
  });
  const sha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : undefined;

  return { committed: true, ...(sha ? { sha } : {}) };
}

async function commitLearningNotes(options: {
  ctx: RunContext;
  worktreeRoot: string;
  runId: string;
  appliedTo: string[];
  message: string;
}): Promise<{ committed: boolean; sha?: string }> {
  const relativePaths = options.appliedTo
    .map((path) => relative(options.worktreeRoot, path))
    .filter((path) => path && !path.startsWith('..'));

  if (relativePaths.length === 0) {
    return { committed: false };
  }

  await runGit(['add', '--', ...relativePaths], {
    cwd: options.worktreeRoot,
    context: { runId: options.runId, repoRoot: options.ctx.repo.repoRoot },
  });

  const diff = await runGit(['diff', '--cached', '--quiet'], {
    cwd: options.worktreeRoot,
    context: { runId: options.runId, repoRoot: options.ctx.repo.repoRoot },
  });

  if (diff.exitCode === 0) {
    return { committed: false };
  }

  const commit = await runGit(['commit', '-m', options.message], {
    cwd: options.worktreeRoot,
    context: { runId: options.runId, repoRoot: options.ctx.repo.repoRoot },
  });

  if (commit.exitCode !== 0) {
    throw new Error(commit.stderr || 'Failed to commit learning notes');
  }

  const shaResult = await runGit(['rev-parse', 'HEAD'], {
    cwd: options.worktreeRoot,
    context: { runId: options.runId, repoRoot: options.ctx.repo.repoRoot },
  });
  const sha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : undefined;

  return { committed: true, ...(sha ? { sha } : {}) };
}

async function updateState(
  ctx: RunContext,
  updater: (data: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const snapshotId = await ctx.state.updateRunState(ctx.runId, (data) => {
    const now = new Date().toISOString();
    const existingRun = typeof data['run'] === 'object' && data['run'] ? data['run'] : {};
    const run = existingRun as Partial<RunMeta>;
    const worktreeInfo = ctx.repo.worktreePath
      ? { path: ctx.repo.worktreePath, branch: ctx.repo.branch }
      : undefined;
    const next = updater({
      ...data,
      run: {
        version: '1.0.0',
        status: (run.status as RunStatus) ?? 'running',
        phase: (run.phase as Phase) ?? 'idle',
        step: run.step,
        attempt: run.attempt ?? 0,
        updatedAt: now,
      },
      steps: typeof data['steps'] === 'object' && data['steps'] ? data['steps'] : {},
      ...(worktreeInfo ? { worktree: worktreeInfo } : {}),
    });
    const nextRun =
      typeof next['run'] === 'object' && next['run'] ? (next['run'] as RunMeta) : null;
    const nextWorktree =
      worktreeInfo ??
      (typeof next['worktree'] === 'object' && next['worktree']
        ? (next['worktree'] as { path?: string; branch?: string })
        : undefined);
    return {
      ...next,
      ...(nextWorktree ? { worktree: nextWorktree } : {}),
      run: {
        version: '1.0.0',
        status: nextRun?.status ?? 'running',
        phase: nextRun?.phase ?? 'idle',
        step: nextRun?.step,
        attempt: nextRun?.attempt ?? 0,
        updatedAt: now,
      },
    };
  });
  await ctx.events.bus.emit(
    createEnvelope({
      type: 'run.persisted',
      source: 'engine',
      level: 'info',
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      payload: {
        path: `${ctx.state.runsDir}/${ctx.runId}.json`,
        snapshotId,
        stateVersion: ctx.state.stateVersion,
      },
    }),
  );
}

async function changePhase(ctx: RunContext, to: Phase, reason?: string): Promise<void> {
  const state = await ctx.state.readRunState(ctx.runId);
  const data = (state?.data as Record<string, unknown>) ?? {};
  const run =
    typeof data['run'] === 'object' && data['run'] ? (data['run'] as RunMeta) : null;
  const from = run?.phase ?? 'idle';

  await updateState(ctx, (prev) => ({
    ...prev,
    run: {
      ...(typeof prev['run'] === 'object' && prev['run'] ? (prev['run'] as RunMeta) : {}),
      phase: to,
    },
  }));

  await ctx.events.bus.emit(
    createEnvelope({
      type: 'run.phase_changed',
      source: 'engine',
      level: 'info',
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      payload: {
        from,
        to,
        ...(reason ? { reason } : {}),
      } satisfies RunPhaseChanged,
    }),
  );
}

async function runStep<T>(
  ctx: RunContext,
  stepId: string,
  title: string,
  fn: () => Promise<T>,
  options?: {
    inputs?: unknown;
    artifacts?: (result: T) => Record<string, unknown>;
  },
): Promise<T> {
  const startedAt = new Date().toISOString();
  const leaseId = crypto.randomUUID();
  const inputsDigest =
    options?.inputs !== undefined
      ? hashString(JSON.stringify(options.inputs))
      : undefined;

  await updateState(ctx, (prev) => {
    const steps = (prev['steps'] as Record<string, StepRecord>) ?? {};
    const existing = steps[stepId] ?? { status: 'not_started' };
    return {
      ...prev,
      run: {
        ...(typeof prev['run'] === 'object' && prev['run']
          ? (prev['run'] as RunMeta)
          : {}),
        status: 'running',
        step: stepId,
        attempt: ((prev['run'] as RunMeta | undefined)?.attempt ?? 0) + 1,
      },
      steps: {
        ...steps,
        [stepId]: {
          ...existing,
          status: 'running',
          startedAt,
          inputsDigest,
          lease: { leaseId, startedAt, heartbeatAt: startedAt },
        },
      },
    };
  });

  await ctx.events.bus.emit(
    createEnvelope({
      type: 'run.step',
      source: 'engine',
      level: 'info',
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      payload: { stepId, title, status: 'running' } satisfies RunStep,
    }),
  );
  try {
    const result = await fn();
    const endedAt = new Date().toISOString();
    const outputPayload = JSON.stringify(result) ?? 'undefined';
    const outputsDigest = hashString(outputPayload);
    const artifacts = await storeArtifacts(
      ctx,
      stepId,
      options?.artifacts ? options.artifacts(result) : undefined,
    );
    await updateState(ctx, (prev) => {
      const steps = (prev['steps'] as Record<string, StepRecord>) ?? {};
      const existing = steps[stepId] ?? { status: 'not_started' };
      const artifactsIndex =
        (prev['artifactsIndex'] as
          | Record<string, Record<string, ArtifactEntry>>
          | undefined) ?? {};
      return {
        ...prev,
        run: {
          ...(typeof prev['run'] === 'object' && prev['run']
            ? (prev['run'] as RunMeta)
            : {}),
          step: undefined,
        },
        steps: {
          ...steps,
          [stepId]: {
            ...existing,
            status: 'done',
            endedAt,
            outputsDigest,
            ...(artifacts ? { artifacts } : {}),
          },
        },
        ...(artifacts
          ? {
              artifactsIndex: {
                ...artifactsIndex,
                [stepId]: {
                  ...(artifactsIndex[stepId] ?? {}),
                  ...artifacts,
                },
              },
            }
          : {}),
      };
    });
    await ctx.events.bus.emit(
      createEnvelope({
        type: 'run.step',
        source: 'engine',
        level: 'info',
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
        payload: { stepId, title, status: 'succeeded' } satisfies RunStep,
      }),
    );
    return result;
  } catch (error) {
    void error;
    const endedAt = new Date().toISOString();
    await updateState(ctx, (prev) => {
      const steps = (prev['steps'] as Record<string, StepRecord>) ?? {};
      const existing = steps[stepId] ?? { status: 'not_started' };
      return {
        ...prev,
        run: {
          ...(typeof prev['run'] === 'object' && prev['run']
            ? (prev['run'] as RunMeta)
            : {}),
          step: undefined,
        },
        steps: {
          ...steps,
          [stepId]: {
            ...existing,
            status: 'failed',
            endedAt,
            error: toEventError(error),
          },
        },
      };
    });
    const errorStore = createConversationStore({
      runId: ctx.runId,
      state: ctx.state,
      config: ctx.config,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    });
    const errorMessage = error instanceof Error ? error.message : `Step ${stepId} failed`;
    const errorConversation = appendMessages(await errorStore.load(), {
      role: 'assistant',
      content: `Error in ${stepId}: ${errorMessage}`,
      metadata: { kind: 'error', protected: true },
    });
    await errorStore.save(errorConversation);
    await ctx.events.bus.emit(
      createEnvelope({
        type: 'run.step',
        source: 'engine',
        level: 'error',
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
        payload: { stepId, title, status: 'failed' } satisfies RunStep,
      }),
    );
    throw error;
  }
}

async function heartbeatStep(ctx: RunContext, stepId: string): Promise<void> {
  const now = new Date().toISOString();
  await ctx.state.updateRunState(ctx.runId, (data) => {
    const steps = (data['steps'] as Record<string, StepRecord>) ?? {};
    const existing = steps[stepId];
    if (!existing?.lease) return data;
    return {
      ...data,
      steps: {
        ...steps,
        [stepId]: {
          ...existing,
          lease: { ...existing.lease, heartbeatAt: now },
        },
      },
    };
  });
}

export async function runPlanner(ctx: RunContext, options: RunControllerOptions) {
  await changePhase(ctx, 'plan');
  const emitContext = {
    runId: ctx.runId,
    repoRoot: ctx.repo.repoRoot,
    mode: ctx.events.mode,
  };
  const conversationStore = createConversationStore({
    runId: ctx.runId,
    state: ctx.state,
    config: ctx.config,
    bus: ctx.events.bus,
    context: emitContext,
  });
  const taskResult = options.task
    ? {
        task: options.task,
        ref: {
          provider: options.task.provider,
          id: options.task.id,
          raw: options.taskRef ?? options.task.id,
        },
      }
    : options.taskRef
      ? await resolveTask(options.taskRef, {
          config: ctx.config,
          repoRoot: ctx.repo.repoRoot,
          state: ctx.state,
          runId: ctx.runId,
          bus: ctx.events.bus,
          context: {
            runId: ctx.runId,
            repoRoot: ctx.repo.repoRoot,
            mode: ctx.events.mode,
          },
        })
      : undefined;

  const kickoffPrompt = taskResult?.task
    ? await runStep(
        ctx,
        'agent.kickoff',
        'Generate kickoff prompt',
        () =>
          generateExecutionKickoffPrompt({
            task: taskResult.task,
            repoRoot: ctx.repo.repoRoot,
            store: conversationStore,
            config: ctx.config,
            bus: ctx.events.bus,
            context: {
              ...emitContext,
              ...(taskResult.task ? { taskId: taskResult.task.id } : {}),
            },
          }),
        {
          artifacts: (prompt) => ({ execution_kickoff: prompt }),
        },
      )
    : undefined;

  const plan = await runStep(ctx, 'agent.plan.generate', 'Generating plan', () =>
    generatePlan({
      ...(taskResult ? { task: taskResult.task } : {}),
      ...(options.worktreeName ? { worktreeName: options.worktreeName } : {}),
      repoRoot: ctx.repo.repoRoot,
      ...(options.clarifications ? { clarifications: options.clarifications } : {}),
      store: conversationStore,
      config: ctx.config,
      cacheDir: ctx.state.cacheDir,
      bus: ctx.events.bus,
      context: {
        ...emitContext,
        ...(taskResult?.task ? { taskId: taskResult.task.id } : {}),
      },
    }),
  );

  await updateState(ctx, (data) => ({
    ...data,
    plan,
    task: taskResult?.task,
    ...(taskResult?.ref ? { taskRef: taskResult.ref } : {}),
    ...(options.clarifications ? { clarifications: options.clarifications } : {}),
    ...(kickoffPrompt
      ? {
          promptDigests: {
            ...(typeof data['promptDigests'] === 'object' && data['promptDigests']
              ? data['promptDigests']
              : {}),
            execution_kickoff: hashPrompt(kickoffPrompt),
          },
          promptSummaries: {
            ...(typeof data['promptSummaries'] === 'object' && data['promptSummaries']
              ? data['promptSummaries']
              : {}),
            execution_kickoff: renderPromptSummary(kickoffPrompt),
          },
        }
      : {}),
    summary: {
      ...(typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}),
      planDigest: hashString(JSON.stringify(plan)),
    },
  }));

  const hasRequiredQuestions = plan.questions?.some(
    (question) => question.required !== false,
  );
  if (hasRequiredQuestions && !options.allowMissingClarifications) {
    throw new SilvanError({
      code: 'task.clarifications_required',
      message: 'Clarifications required before execution.',
      userMessage: 'Clarifications required before execution.',
      kind: 'expected',
      exitCode: 0,
      nextSteps: ['Run `silvan agent clarify` to answer questions.'],
      context: { runId: ctx.runId },
    });
  }

  return plan;
}

export async function runImplementation(
  ctx: RunContext,
  options: RunControllerOptions,
): Promise<boolean> {
  const state = await ctx.state.readRunState(ctx.runId);
  const data = getRunState((state?.data as Record<string, unknown>) ?? {});
  const planResult = planSchema.safeParse(data['plan']);
  if (!planResult.success) {
    throw new Error('No plan found in run state. Run agent plan first.');
  }
  const plan = planResult.data;
  const clarifications =
    typeof data['clarifications'] === 'object' && data['clarifications']
      ? (data['clarifications'] as Record<string, string>)
      : {};
  const missingClarifications = plan.questions?.filter((question) => {
    const answer = clarifications[question.id];
    return question.required !== false && (!answer || answer.trim() === '');
  });
  if (missingClarifications && missingClarifications.length > 0) {
    throw new Error('Clarifications required before execution.');
  }

  await changePhase(ctx, 'implement');
  const execModel = getModelForPhase(ctx.config, 'execute');
  const execBudgets = getBudgetsForPhase(ctx.config, 'execute');
  const worktreeRoot = ctx.repo.worktreePath ?? ctx.repo.repoRoot;
  const task = (data['task'] as Task | undefined) ?? undefined;
  const emitContext = {
    runId: ctx.runId,
    repoRoot: ctx.repo.repoRoot,
    mode: ctx.events.mode,
    ...(task ? { taskId: task.id } : {}),
  };
  const conversationStore = createConversationStore({
    runId: ctx.runId,
    state: ctx.state,
    config: ctx.config,
    bus: ctx.events.bus,
    context: emitContext,
  });
  if (task) {
    const moveStep = getStepRecord(data, 'task.move_in_progress');
    if (moveStep?.status !== 'done') {
      await runStep(ctx, 'task.move_in_progress', 'Move task to In Progress', () =>
        moveTaskToInProgress(task, ctx.config),
      );
    }
  }
  const toolCallLog: Array<{
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    resultDigest?: string;
    ok: boolean;
  }> = [];
  const execStep = getStepRecord(data, 'agent.execute');
  const existingSummary =
    typeof data['implementationSummary'] === 'string'
      ? data['implementationSummary']
      : undefined;
  const planDigest = hashString(JSON.stringify(plan));
  const summary =
    execStep?.status === 'done' && existingSummary
      ? existingSummary
      : await runStep(
          ctx,
          'agent.execute',
          'Execute plan',
          async () => {
            const execPrompt = new ProseWriter();
            execPrompt.write('You are the implementation agent for Silvan.');
            execPrompt.write('Follow the plan step-by-step, using tools when needed.');
            execPrompt.write('Do not invent file contents; use fs.read before edits.');
            execPrompt.write('Keep changes minimal and aligned to the plan.');
            execPrompt.write(
              'Use silvan.plan.read to fetch the full plan before making edits.',
            );
            execPrompt.write('Use silvan.task.read to fetch the task details as needed.');
            execPrompt.write('Return a brief summary of changes.');
            execPrompt.write(`Plan digest: ${planDigest}`);

            const execSnapshot = await conversationStore.append({
              role: 'system',
              content: execPrompt.toString().trimEnd(),
              metadata: { kind: 'plan' },
            });

            const result = await executePlan({
              snapshot: execSnapshot,
              model: execModel,
              repoRoot: worktreeRoot,
              config: ctx.config,
              dryRun: Boolean(options.dryRun),
              allowDestructive: Boolean(options.apply),
              allowDangerous: Boolean(options.dangerous),
              ...(options.sessions ? { sessionPool: options.sessions } : {}),
              bus: ctx.events.bus,
              context: emitContext,
              state: ctx.state,
              ...execBudgets,
              ...getToolBudget(ctx.config),
              heartbeat: () => heartbeatStep(ctx, 'agent.execute'),
              toolCallLog,
            });

            const execConversation = appendMessages(execSnapshot.conversation, {
              role: 'assistant',
              content: `Implementation summary: ${result}`,
              metadata: { kind: 'plan', protected: true },
            });
            await conversationStore.save(execConversation);
            return result;
          },
          {
            inputs: { planDigest },
            artifacts: () => ({ toolCalls: toolCallLog }),
          },
        );

  await updateState(ctx, (data) => ({
    ...data,
    implementationSummary: summary,
    toolCallSummary: {
      total: toolCallLog.length,
      failed: toolCallLog.filter((call) => !call.ok).length,
    },
  }));

  const implementationCheckpoint = await runStep(
    ctx,
    'git.checkpoint',
    'Checkpoint implementation',
    () => createCheckpointCommit(ctx, 'silvan: checkpoint implement'),
    {
      inputs: { phase: 'implement' },
      artifacts: (result) => ({ checkpoint: result }),
    },
  );
  if (implementationCheckpoint?.sha) {
    await updateState(ctx, (data) => ({
      ...data,
      checkpoints: [
        ...((data['checkpoints'] as string[]) ?? []),
        implementationCheckpoint.sha,
      ],
    }));
  }

  await changePhase(ctx, 'verify');
  const verifyStep = getStepRecord(data, 'verify.run');
  const existingVerify = data['verifySummary'];
  let verifyReport =
    verifyStep?.status === 'done' &&
    typeof existingVerify === 'object' &&
    existingVerify &&
    (existingVerify as { ok?: boolean }).ok === true
      ? { ok: true, results: [] }
      : await runStep(
          ctx,
          'verify.run',
          'Run verification',
          () => runVerifyCommands(ctx.config, { cwd: worktreeRoot }),
          {
            artifacts: (report) => ({ report }),
          },
        );
  await updateState(ctx, (data) => ({
    ...data,
    verifySummary: {
      ok: verifyReport.ok,
      lastRunAt: new Date().toISOString(),
    },
  }));

  if (!verifyReport.ok) {
    await recordVerificationAssist({
      ctx,
      report: verifyReport,
      context: 'verify',
      emitContext,
    });
    const results = (
      verifyReport.results as Array<{
        name: string;
        exitCode: number;
        stderr: string;
      }>
    ).map((result) => ({
      name: result.name,
      exitCode: result.exitCode,
      stderr: result.stderr,
    }));

    let failedResults = results.filter((result) => result.exitCode !== 0);
    let triage = triageVerificationFailures(failedResults);
    const autoFixOutcome = await attemptVerificationAutoFix({
      ctx,
      emitContext,
      conversationStore,
      worktreeRoot,
      failures: failedResults,
      triageClassified: triage.classified,
      controllerOptions: options,
      context: 'verify',
    });
    if (autoFixOutcome.report) {
      verifyReport = autoFixOutcome.report;
      if (!verifyReport.ok) {
        const retryResults = (
          verifyReport.results as Array<{
            name: string;
            exitCode: number;
            stderr: string;
          }>
        )
          .filter((result) => result.exitCode !== 0)
          .map((result) => ({
            name: result.name,
            exitCode: result.exitCode,
            stderr: result.stderr,
          }));
        failedResults = retryResults;
        triage = triageVerificationFailures(failedResults);
        await recordVerificationAssist({
          ctx,
          report: verifyReport,
          context: 'verify',
          emitContext,
        });
      }
    }
    if (!autoFixOutcome.resolved) {
      const decision = await runStep(
        ctx,
        'verify.decide',
        'Decide verification next steps',
        async () => {
          if (options.apply && !triage.classified) {
            return decideVerification({
              report: {
                ok: verifyReport.ok,
                results: failedResults,
              },
              store: conversationStore,
              config: ctx.config,
              ...(ctx.events.bus ? { bus: ctx.events.bus } : {}),
              context: emitContext,
            });
          }
          return triage.decision;
        },
        {
          inputs: {
            classified: triage.classified,
            commandCount: failedResults.length,
          },
          artifacts: (result) => ({ decision: result }),
        },
      );

      await updateState(ctx, (data) => ({
        ...data,
        verificationDecisionSummary: {
          commands: decision.commands,
          askUser: decision.askUser ?? false,
        },
      }));
      throw new Error('Verification failed');
    }
  }

  const localGateConfig = ctx.config.review.localGate;
  const gateBaseBranch = ctx.config.github.baseBranch ?? ctx.config.repo.defaultBranch;
  const localGateRunWhen = localGateConfig.runWhen;
  const shouldRunLocalGateBeforePr =
    localGateConfig.enabled &&
    (localGateRunWhen === 'beforePrOpen' || localGateRunWhen === 'both');
  const localGateStep = getStepRecord(data, 'review.local_gate');
  const existingLocalGateEntry = getArtifactEntry(data, 'review.local_gate', 'report');
  let localGateReport =
    localGateStep?.status === 'done' && existingLocalGateEntry
      ? await readArtifact<import('../review/local-gate').LocalGateReport>({
          entry: existingLocalGateEntry,
        })
      : undefined;

  if (shouldRunLocalGateBeforePr && !localGateReport) {
    localGateReport = await runStep(
      ctx,
      'review.local_gate',
      'Run local review gate',
      () =>
        generateLocalGateReport({
          repoRoot: ctx.repo.repoRoot,
          baseBranch: gateBaseBranch,
          branchName: ctx.repo.branch,
          ...(ctx.repo.worktreePath ? { worktreePath: ctx.repo.worktreePath } : {}),
          config: ctx.config,
          state: ctx.state,
          runId: ctx.runId,
          bus: ctx.events.bus,
          context: emitContext,
        }),
      {
        artifacts: (report) => ({ report }),
      },
    );

    const blockers = localGateReport.findings.filter(
      (finding) => finding.severity === 'blocker',
    ).length;
    const warnings = localGateReport.findings.filter(
      (finding) => finding.severity === 'warn',
    ).length;

    await updateState(ctx, (data) => ({
      ...data,
      localGateSummary: {
        ok: localGateReport?.ok ?? false,
        blockers,
        warnings,
        generatedAt: localGateReport?.generatedAt,
      },
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary']
          ? data['summary']
          : {}),
        ...(localGateReport
          ? { localGate: formatLocalGateSummary(localGateReport) }
          : {}),
      },
    }));

    if (!localGateReport.ok && localGateConfig.blockPrOnFail) {
      await updateState(ctx, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          blockedReason: 'Local review gate failed.',
        },
      }));
      throw new Error('Local review gate failed');
    }
  }

  await changePhase(ctx, 'pr');
  let githubToken: string | undefined;
  let githubConfig: { owner: string; repo: string };
  try {
    githubToken = requireGitHubAuth(ctx.config);
    githubConfig = await requireGitHubConfig({
      config: ctx.config,
      repoRoot: ctx.repo.repoRoot,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      bus: ctx.events.bus,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await updateState(ctx, (data) => ({
      ...data,
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary']
          ? data['summary']
          : {}),
        blockedReason: `GitHub not configured. Skipping PR and review steps. ${errorMessage}`,
      },
    }));
    await changePhase(ctx, 'complete', 'github_unconfigured');
    return false;
  }
  const planSummary = plan.summary ?? 'Plan';
  const taskUrl = task?.url;
  const taskId = task?.id;
  const prDraftStep = getStepRecord(data, 'pr.draft');
  const existingDraftEntry = getArtifactEntry(data, 'pr.draft', 'draft');
  const existingDraft =
    prDraftStep?.status === 'done' && existingDraftEntry
      ? await readArtifact<{ title: string; body: string }>({ entry: existingDraftEntry })
      : undefined;
  const prDraft =
    prDraftStep?.status === 'done' && existingDraft
      ? existingDraft
      : await runStep(
          ctx,
          'pr.draft',
          'Draft PR description',
          () =>
            draftPullRequest({
              planSummary,
              changesSummary: summary,
              ...(taskUrl ? { taskUrl } : {}),
              ...(taskId ? { taskId } : {}),
              store: conversationStore,
              config: ctx.config,
              cacheDir: ctx.state.cacheDir,
              bus: ctx.events.bus,
              context: emitContext,
            }),
          {
            artifacts: (draft) => ({ draft }),
          },
        );
  await updateState(ctx, (data) => ({
    ...data,
    prDraftSummary: { title: prDraft.title, bodyDigest: hashString(prDraft.body) },
  }));

  const { owner, repo } = githubConfig;
  const headBranch = ctx.repo.branch;
  const baseBranch = ctx.config.github.baseBranch ?? ctx.config.repo.defaultBranch;
  const prStep = getStepRecord(data, 'github.pr.open');
  const existingPr =
    typeof data['pr'] === 'object' && data['pr']
      ? (data['pr'] as {
          pr: { url?: string; number: number; owner: string; repo: string };
        })
      : undefined;
  const prResult =
    prStep?.status === 'done' && existingPr
      ? existingPr
      : await runStep(ctx, 'github.pr.open', 'Open or update PR', () =>
          openOrUpdatePr({
            owner,
            repo,
            headBranch,
            baseBranch,
            title: prDraft.title,
            body: prDraft.body,
            token: githubToken,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
        );
  await updateState(ctx, (data) => ({ ...data, pr: prResult }));

  if (task && prResult.pr.url) {
    const commentStep = getStepRecord(data, 'task.comment_pr_open');
    if (commentStep?.status !== 'done') {
      await runStep(ctx, 'task.comment_pr_open', 'Comment on task with PR', () =>
        commentOnPrOpen(task, ctx.config, prResult.pr.url ?? ''),
      );
    }
  }

  if (task) {
    const moveStep = getStepRecord(data, 'task.move_in_review');
    if (moveStep?.status !== 'done') {
      await runStep(ctx, 'task.move_in_review', 'Move task to In Review', () =>
        moveTaskToInReview(task, ctx.config),
      );
    }
  }

  const initialCiStep = getStepRecord(data, 'ci.wait.initial');
  if (initialCiStep?.status !== 'done') {
    const ciResult = await runStep(ctx, 'ci.wait.initial', 'Wait for CI', () =>
      waitForCi({
        owner,
        repo,
        headBranch,
        token: githubToken,
        pollIntervalMs: 15000,
        timeoutMs: 900000,
        onHeartbeat: () => heartbeatStep(ctx, 'ci.wait.initial'),
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );
    await updateState(ctx, (data) => ({
      ...data,
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary']
          ? data['summary']
          : {}),
        ci: ciResult.state,
      },
    }));
    if (ciResult.state === 'failing') {
      throw new Error('CI failed before review request');
    }
  }

  const shouldRunLocalGateBeforeReview =
    localGateConfig.enabled &&
    (localGateRunWhen === 'beforeReviewRequest' || localGateRunWhen === 'both');
  if (shouldRunLocalGateBeforeReview && !localGateReport) {
    localGateReport = await runStep(
      ctx,
      'review.local_gate',
      'Run local review gate',
      () =>
        generateLocalGateReport({
          repoRoot: ctx.repo.repoRoot,
          baseBranch: gateBaseBranch,
          branchName: ctx.repo.branch,
          ...(ctx.repo.worktreePath ? { worktreePath: ctx.repo.worktreePath } : {}),
          config: ctx.config,
          state: ctx.state,
          runId: ctx.runId,
          bus: ctx.events.bus,
          context: emitContext,
        }),
      {
        artifacts: (report) => ({ report }),
      },
    );

    const blockers = localGateReport.findings.filter(
      (finding) => finding.severity === 'blocker',
    ).length;
    const warnings = localGateReport.findings.filter(
      (finding) => finding.severity === 'warn',
    ).length;

    await updateState(ctx, (data) => ({
      ...data,
      localGateSummary: {
        ok: localGateReport?.ok ?? false,
        blockers,
        warnings,
        generatedAt: localGateReport?.generatedAt,
      },
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary']
          ? data['summary']
          : {}),
        ...(localGateReport
          ? { localGate: formatLocalGateSummary(localGateReport) }
          : {}),
      },
    }));

    if (!localGateReport.ok && localGateConfig.blockPrOnFail) {
      await updateState(ctx, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          blockedReason: 'Local review gate failed.',
        },
      }));
      throw new Error('Local review gate failed');
    }
  }

  if (localGateReport && localGateReport.ok && ctx.config.review.aiReviewer.enabled) {
    const aiReviewStep = getStepRecord(data, 'review.ai_reviewer');
    const existingAiReviewEntry = getArtifactEntry(data, 'review.ai_reviewer', 'report');
    const existingAiReview =
      aiReviewStep?.status === 'done' && existingAiReviewEntry
        ? await readArtifact<import('../review/ai-reviewer').AiReviewReport>({
            entry: existingAiReviewEntry,
          })
        : undefined;
    const diffStat = await runGit(['diff', '--stat', `${gateBaseBranch}...HEAD`], {
      cwd: worktreeRoot,
      bus: ctx.events.bus,
      context: emitContext,
    });
    const aiReview =
      existingAiReview ??
      (await runStep(
        ctx,
        'review.ai_reviewer',
        'Run AI reviewer',
        () =>
          runAiReviewer({
            summary: {
              diffStat: diffStat.stdout.trim(),
              findings: localGateReport.findings.map((finding) => ({
                severity: finding.severity,
                title: finding.title,
                ...(finding.file ? { file: finding.file } : {}),
              })),
            },
            ...(task
              ? {
                  task: {
                    ...(task.key ? { key: task.key } : {}),
                    ...(task.title ? { title: task.title } : {}),
                    ...(task.acceptanceCriteria.length > 0
                      ? { acceptanceCriteria: task.acceptanceCriteria }
                      : {}),
                  },
                }
              : {}),
            store: conversationStore,
            config: ctx.config,
            bus: ctx.events.bus,
            context: emitContext,
          }),
        {
          artifacts: (report) => ({ report }),
        },
      ));

    await updateState(ctx, (data) => ({
      ...data,
      aiReviewSummary: {
        shipIt: aiReview.shipIt,
        issues: aiReview.issues.length,
      },
    }));
  }
  const reviewStep = getStepRecord(data, 'github.review.request');
  const reviewIntelligence = ctx.config.review.intelligence;
  let reviewerSuggestions: Awaited<ReturnType<typeof suggestReviewers>> | null = null;
  if (reviewIntelligence?.enabled && reviewIntelligence.reviewerSuggestions.enabled) {
    try {
      const reviewerStats = await readReviewerStats(ctx.state);
      reviewerSuggestions = await suggestReviewers({
        repoRoot: worktreeRoot,
        baseBranch,
        headBranch: headBranch ?? baseBranch,
        reviewerAliases: reviewIntelligence.reviewerSuggestions.reviewerAliases ?? {},
        useCodeowners: reviewIntelligence.reviewerSuggestions.useCodeowners,
        useBlame: reviewIntelligence.reviewerSuggestions.useBlame,
        maxSuggestions: reviewIntelligence.reviewerSuggestions.maxSuggestions,
        reviewerStats,
      });
      if (reviewerSuggestions) {
        const suggestions = reviewerSuggestions;
        await updateState(ctx, (data) => ({
          ...data,
          reviewerSuggestions: {
            users: suggestions.users,
            teams: suggestions.teams,
            sources: suggestions.sources,
            changedFiles: suggestions.changedFiles,
            generatedAt: new Date().toISOString(),
          },
        }));
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to suggest reviewers';
      await updateState(ctx, (data) => ({
        ...data,
        reviewerSuggestions: {
          users: [],
          teams: [],
          sources: { codeowners: [], blame: [] },
          changedFiles: [],
          generatedAt: new Date().toISOString(),
          error: message,
        },
      }));
    }
  }

  const suggestedUsers = reviewerSuggestions?.users ?? [];
  const reviewersToRequest =
    ctx.config.github.reviewers.length > 0
      ? ctx.config.github.reviewers
      : reviewIntelligence?.reviewerSuggestions.autoRequest
        ? suggestedUsers
        : [];

  const requestKey = reviewRequestKey({
    prNumber: prResult.pr.number,
    reviewers: reviewersToRequest,
    requestCopilot: ctx.config.github.requestCopilot,
  });
  const existingRequestKey =
    typeof data['reviewRequestKey'] === 'string' ? data['reviewRequestKey'] : undefined;
  if (reviewStep?.status !== 'done' || existingRequestKey !== requestKey) {
    await runStep(ctx, 'github.review.request', 'Request reviewers', () =>
      requestReviewers({
        pr: prResult.pr,
        reviewers: reviewersToRequest,
        requestCopilot: ctx.config.github.requestCopilot,
        token: githubToken,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );
    const requestedAt = new Date().toISOString();
    await updateState(ctx, (data) => ({
      ...data,
      reviewRequestKey: requestKey,
      reviewRequest: {
        reviewers: reviewersToRequest,
        suggestedReviewers: suggestedUsers,
        requestedAt,
        copilot: ctx.config.github.requestCopilot,
      },
    }));
    if (reviewersToRequest.length > 0) {
      await recordReviewerRequests({ state: ctx.state, reviewers: reviewersToRequest });
    }
  }

  await updateState(ctx, (data) => ({ ...data, pr: prResult.pr }));
  return true;
}

export async function runReviewLoop(ctx: RunContext, options: RunControllerOptions) {
  await changePhase(ctx, 'review');
  const githubToken = requireGitHubAuth(ctx.config);
  const execModel = getModelForPhase(ctx.config, 'execute');
  const execBudgets = getBudgetsForPhase(ctx.config, 'execute');
  const worktreeRoot = ctx.repo.worktreePath ?? ctx.repo.repoRoot;
  const headBranch = ctx.repo.branch;
  const reviewState = await ctx.state.readRunState(ctx.runId);
  const reviewData = (reviewState?.data as Record<string, unknown>) ?? {};
  const reviewTask =
    typeof reviewData['task'] === 'object' && reviewData['task']
      ? (reviewData['task'] as Task)
      : undefined;
  const emitContext = {
    runId: ctx.runId,
    repoRoot: ctx.repo.repoRoot,
    mode: ctx.events.mode,
    ...(reviewTask ? { taskId: reviewTask.id } : {}),
  };
  const conversationStore = createConversationStore({
    runId: ctx.runId,
    state: ctx.state,
    config: ctx.config,
    bus: ctx.events.bus,
    context: emitContext,
  });
  const github = await requireGitHubConfig({
    config: ctx.config,
    repoRoot: ctx.repo.repoRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    bus: ctx.events.bus,
  });
  const { owner, repo } = github;
  const maxIterations = ctx.config.review.maxIterations ?? 3;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const iterationIndex = iteration + 1;
    const iterationState = await ctx.state.readRunState(ctx.runId);
    const iterationData = getRunState(iterationState?.data ?? {});
    const priorCheckpoint =
      typeof iterationData['lastReviewCheckpoint'] === 'string'
        ? iterationData['lastReviewCheckpoint']
        : undefined;

    try {
      const ciResult = await runStep(ctx, 'ci.wait.review', 'Wait for CI', () =>
        waitForCi({
          owner,
          repo,
          headBranch,
          token: githubToken,
          pollIntervalMs: 15000,
          timeoutMs: 900000,
          onHeartbeat: () => heartbeatStep(ctx, 'ci.wait.review'),
          bus: ctx.events.bus,
          context: {
            runId: ctx.runId,
            repoRoot: ctx.repo.repoRoot,
            mode: ctx.events.mode,
          },
        }),
      );

      await updateState(ctx, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          ci: ciResult.state,
        },
      }));

      let finalCiState = ciResult.state;
      if (ciResult.state === 'failing') {
        const ciChecks = ciResult.checks ?? [];
        const ciPlan = await runStep(
          ctx,
          'ci.fix.plan',
          'Plan CI fixes',
          () =>
            generateCiFixPlan({
              ci: {
                state: ciResult.state,
                ...(ciResult.summary ? { summary: ciResult.summary } : {}),
                checks: ciChecks.map((check) => ({
                  name: check.name,
                  ...(check.conclusion ? { conclusion: check.conclusion } : {}),
                  ...(check.url ? { url: check.url } : {}),
                })),
              },
              store: conversationStore,
              config: ctx.config,
              ...(ctx.events.bus ? { bus: ctx.events.bus } : {}),
              context: emitContext,
            }),
          {
            artifacts: (result) => ({ plan: result }),
          },
        );

        await updateState(ctx, (data) => ({
          ...data,
          ciFixSummary: {
            summary: ciPlan.summary,
            steps: ciPlan.steps.length,
          },
        }));

        const ciPlanDigest = hashString(JSON.stringify(ciPlan));
        await runStep(ctx, 'ci.fix.apply', 'Apply CI fixes', () =>
          (async () => {
            const execPrompt = new ProseWriter();
            execPrompt.write('You are the implementation agent for Silvan.');
            execPrompt.write('Follow the plan step-by-step, using tools when needed.');
            execPrompt.write('Do not invent file contents; use fs.read before edits.');
            execPrompt.write('Keep changes minimal and aligned to the plan.');
            execPrompt.write(
              'Use silvan.plan.read to fetch the full plan before making edits.',
            );
            execPrompt.write('Return a brief summary of changes.');
            execPrompt.write(`Plan digest: ${ciPlanDigest}`);

            const execSnapshot = await conversationStore.append({
              role: 'system',
              content: execPrompt.toString().trimEnd(),
              metadata: { kind: 'plan' },
            });

            const result = await executePlan({
              snapshot: execSnapshot,
              model: execModel,
              repoRoot: worktreeRoot,
              config: ctx.config,
              dryRun: Boolean(options.dryRun),
              allowDestructive: Boolean(options.apply),
              allowDangerous: Boolean(options.dangerous),
              ...execBudgets,
              ...getToolBudget(ctx.config),
              ...(options.sessions ? { sessionPool: options.sessions } : {}),
              bus: ctx.events.bus,
              context: emitContext,
              state: ctx.state,
              heartbeat: () => heartbeatStep(ctx, 'ci.fix.apply'),
            });

            const execConversation = appendMessages(execSnapshot.conversation, {
              role: 'assistant',
              content: `CI fix summary: ${result}`,
              metadata: { kind: 'ci', protected: true },
            });
            await conversationStore.save(execConversation);
            return result;
          })(),
        );

        const ciVerify = await runStep(ctx, 'ci.fix.verify', 'Verify CI fixes', () =>
          runVerifyCommands(ctx.config, { cwd: worktreeRoot }),
        );
        if (!ciVerify.ok) {
          await recordVerificationAssist({
            ctx,
            report: ciVerify,
            context: 'ci_fix',
            emitContext,
          });
          throw new Error('Verification failed during CI fix');
        }

        await runStep(ctx, 'ci.fix.checkpoint', 'Checkpoint CI fixes', () =>
          createCheckpointCommit(ctx, `silvan: checkpoint ci-${iteration + 1}`),
        );

        await runStep(ctx, 'ci.fix.push', 'Push CI fixes', () =>
          runGit(['push', 'origin', headBranch], {
            cwd: worktreeRoot,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
          }),
        );

        const ciAfter = await runStep(ctx, 'ci.wait.review', 'Wait for CI', () =>
          waitForCi({
            owner,
            repo,
            headBranch,
            token: githubToken,
            pollIntervalMs: 15000,
            timeoutMs: 900000,
            onHeartbeat: () => heartbeatStep(ctx, 'ci.wait.review'),
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
        );
        finalCiState = ciAfter.state;
        if (ciAfter.state === 'failing') {
          await updateState(ctx, (data) => ({
            ...data,
            summary: {
              ...(typeof data['summary'] === 'object' && data['summary']
                ? data['summary']
                : {}),
              blockedReason: 'CI still failing after automated fixes.',
            },
          }));
          await recordArtifacts(ctx, 'review-iterations', {
            [`iteration-${iterationIndex}`]: {
              iteration: iterationIndex,
              status: 'blocked',
              reason: 'ci_fix_failed',
              unresolvedBefore: 0,
              actionable: 0,
              ignored: 0,
              ciState: ciAfter.state,
              generatedAt: new Date().toISOString(),
            },
          });
          throw new Error('CI still failing after fixes');
        }
        continue;
      }

      const review = await runStep(
        ctx,
        'github.review.fetch',
        'Fetch review comments',
        () =>
          fetchUnresolvedReviewComments({
            owner,
            repo,
            headBranch,
            token: githubToken,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
      );

      await updateState(ctx, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          unresolvedReviewCount: review.comments.length,
        },
      }));

      const reviewRequest = (typeof iterationData['reviewRequest'] === 'object' &&
      iterationData['reviewRequest']
        ? (iterationData['reviewRequest'] as {
            reviewers?: string[];
            requestedAt?: string;
          })
        : undefined) ?? { reviewers: [], requestedAt: undefined };
      const requestedAt = reviewRequest.requestedAt;
      const requestedReviewers = Array.isArray(reviewRequest.reviewers)
        ? reviewRequest.reviewers
        : [];

      if (requestedAt && requestedReviewers.length > 0) {
        const responses = await fetchReviewResponses({
          pr: review.pr,
          token: githubToken,
          since: requestedAt,
          bus: ctx.events.bus,
          context: emitContext,
        });
        const responseByReviewer = new Map<string, { submittedAt: string }>();
        for (const response of responses) {
          const existing = responseByReviewer.get(response.reviewer);
          if (!existing || response.submittedAt < existing.submittedAt) {
            responseByReviewer.set(response.reviewer, {
              submittedAt: response.submittedAt,
            });
          }
        }
        const respondedReviewers = Array.from(responseByReviewer.keys());
        const pendingReviewers = requestedReviewers.filter(
          (reviewer) => !responseByReviewer.has(reviewer),
        );
        const requestTs = Date.parse(requestedAt);
        const responseTimes = respondedReviewers
          .map((reviewer) => {
            const submittedAt = responseByReviewer.get(reviewer)?.submittedAt ?? '';
            const submittedTs = Date.parse(submittedAt);
            if (Number.isNaN(requestTs) || Number.isNaN(submittedTs)) return null;
            const hours = (submittedTs - requestTs) / (1000 * 60 * 60);
            return { reviewer, responseHours: hours, respondedAt: submittedAt };
          })
          .filter(
            (
              entry,
            ): entry is {
              reviewer: string;
              responseHours: number;
              respondedAt: string;
            } => entry !== null,
          );
        const avgResponseHours =
          responseTimes.length > 0
            ? responseTimes.reduce((sum, entry) => sum + entry.responseHours, 0) /
              responseTimes.length
            : undefined;
        const previousSummary = (iterationData['reviewResponseSummary'] as
          | { respondedReviewers?: string[] }
          | undefined) ?? { respondedReviewers: [] };
        const recordedReviewers = new Set(previousSummary.respondedReviewers ?? []);
        const newResponses = responseTimes.filter(
          (entry) => !recordedReviewers.has(entry.reviewer),
        );
        if (newResponses.length > 0) {
          await recordReviewerResponses({ state: ctx.state, responses: newResponses });
        }
        await updateState(ctx, (data) => ({
          ...data,
          reviewResponseSummary: {
            requestedAt,
            reviewers: requestedReviewers,
            respondedReviewers,
            pendingReviewers,
            ...(avgResponseHours !== undefined ? { avgResponseHours } : {}),
            ...(responseTimes.length > 0
              ? {
                  lastResponseAt: responseTimes
                    .map((entry) => entry.respondedAt)
                    .sort()
                    .slice(-1)[0],
                }
              : {}),
          },
        }));
      }

      if (review.comments.length === 0 && ciResult.state === 'passing') {
        await changePhase(ctx, 'complete', 'review_loop_clean');
        const latest = await ctx.state.readRunState(ctx.runId);
        const latestData = getRunState((latest?.data as Record<string, unknown>) ?? {});
        const task = latestData['task'] as Task | undefined;
        if (task) {
          await runStep(ctx, 'task.move_done', 'Move task to Done', () =>
            completeTask(task, ctx.config),
          );
        }
        break;
      }

      const threadFingerprints = review.comments.reduce<
        Record<string, ReviewThreadFingerprint>
      >((acc, comment) => {
        const entry = (acc[comment.threadId] ??= {
          threadId: comment.threadId,
          comments: [],
          isOutdated: comment.isOutdated,
        });
        entry.comments.push({
          id: comment.id,
          databaseId: comment.databaseId ?? null,
          path: comment.path,
          line: comment.line,
          bodyDigest: hashString(comment.body),
          excerpt: comment.body.slice(0, 160),
        });
        return acc;
      }, {});

      await recordArtifacts(ctx, 'github.review.fetch', {
        threads: Object.values(threadFingerprints),
      });

      const reviewKickoff = await runStep(
        ctx,
        'review.kickoff',
        'Generate review remediation kickoff',
        () =>
          generateReviewRemediationKickoffPrompt({
            task: reviewTask ?? {
              id: 'unknown',
              key: 'unknown',
              provider: 'local',
              title: 'Unknown task',
              description: '',
              acceptanceCriteria: [],
              labels: [],
            },
            pr: {
              id: `${review.pr.owner}/${review.pr.repo}#${review.pr.number}`,
              ...(review.pr.url ? { url: review.pr.url } : {}),
              branch: headBranch,
            },
            review: {
              unresolvedThreadCount: review.comments.length,
              threadFingerprints: Object.values(threadFingerprints).map((thread) => ({
                threadId: thread.threadId,
                commentIds: thread.comments.map((comment) => comment.id),
                path: thread.comments[0]?.path ?? null,
                line: thread.comments[0]?.line ?? 0,
                isOutdated: thread.isOutdated,
                bodyHash: thread.comments[0]?.bodyDigest ?? '',
                excerpt: thread.comments[0]?.excerpt ?? '',
              })),
            },
            ci: {
              state: ciResult.state,
              ...(ciResult.summary ? { summary: ciResult.summary } : {}),
              failedChecks: (ciResult.checks ?? [])
                .filter((check) => check.conclusion === 'failure')
                .map((check) => check.name),
            },
            repo: {
              frameworks: [],
              verificationCommands: ctx.config.verify.commands.map(
                (command) => command.cmd,
              ),
            },
            store: conversationStore,
            config: ctx.config,
            bus: ctx.events.bus,
            context: emitContext,
          }),
        {
          artifacts: (prompt) => ({ review_remediation_kickoff: prompt }),
        },
      );

      await updateState(ctx, (data) => ({
        ...data,
        promptDigests: {
          ...(typeof data['promptDigests'] === 'object' && data['promptDigests']
            ? data['promptDigests']
            : {}),
          review_remediation_kickoff: hashPrompt(reviewKickoff),
        },
        promptSummaries: {
          ...(typeof data['promptSummaries'] === 'object' && data['promptSummaries']
            ? data['promptSummaries']
            : {}),
          review_remediation_kickoff: renderPromptSummary(reviewKickoff),
        },
      }));

      const classification = await runStep(
        ctx,
        'review.classify',
        'Classify review threads',
        () =>
          classifyReviewThreads({
            threads: Object.values(threadFingerprints),
            store: conversationStore,
            config: ctx.config,
            cacheDir: ctx.state.cacheDir,
            bus: ctx.events.bus,
            context: emitContext,
          }),
        {
          artifacts: (result) => ({ classification: result }),
          inputs: { threadCount: review.comments.length },
        },
      );

      const fingerprintList = Object.values(threadFingerprints);
      const reviewIntelligence = ctx.config.review.intelligence;
      const severityIndex = buildSeverityIndex({
        classification,
        fingerprints: fingerprintList,
      });
      const severitySummary = buildSeveritySummary(severityIndex.severityByThreadId);
      const applyIntelligence = reviewIntelligence.enabled;
      const policyAction = applyIntelligence
        ? applySeverityPolicy({
            severityByThreadId: severityIndex.severityByThreadId,
            policy: reviewIntelligence.severityPolicy,
          })
        : {
            actionableThreadIds: classification.actionableThreadIds,
            ignoredThreadIds: classification.ignoredThreadIds,
            autoResolveThreadIds: [],
          };

      let actionableThreadIds = policyAction.actionableThreadIds;
      let ignoredThreadIds = policyAction.ignoredThreadIds;
      let autoResolveThreadIds = policyAction.autoResolveThreadIds;

      if (!applyIntelligence) {
        autoResolveThreadIds = [];
      }

      await updateState(ctx, (data) => ({
        ...data,
        reviewClassificationSummary: {
          actionable: actionableThreadIds.length,
          ignored: ignoredThreadIds.length,
          needsContext: classification.needsContextThreadIds.length,
          severity: severitySummary,
        },
        reviewThreadPriority: buildReviewPriorityList({
          fingerprints: fingerprintList,
          severityByThreadId: severityIndex.severityByThreadId,
          summaryByThreadId: severityIndex.summaryByThreadId,
        }),
      }));
      const threadsNeedingContext = selectThreadsForContext({
        fingerprints: fingerprintList,
        needsContextThreadIds: classification.needsContextThreadIds,
      });

      const autoResolveEnabled = applyIntelligence && autoResolveThreadIds.length > 0;
      let resolvedAutoResolveIds: string[] = [];
      let autoResolveFailures: Array<{ threadId: string; reason: string }> = [];
      let autoResolveSkipped: Array<{ threadId: string; reason: string }> = [];

      if (autoResolveEnabled) {
        const allowAutoResolve = Boolean(options.apply);
        if (!allowAutoResolve) {
          autoResolveSkipped = autoResolveThreadIds.map((threadId) => ({
            threadId,
            reason: 'apply_disabled',
          }));
        } else {
          const autoResolveStep = getStepRecord(iterationData, 'review.nitpick.resolve');
          if (autoResolveStep?.status !== 'done') {
            const autoResolveResult = await runStep(
              ctx,
              'review.nitpick.resolve',
              'Resolve nitpick review threads',
              async () => {
                const resolved: string[] = [];
                const skipped: Array<{ threadId: string; reason: string }> = [];
                const failed: Array<{ threadId: string; reason: string }> = [];
                const byId = new Map(
                  fingerprintList.map((thread) => [thread.threadId, thread]),
                );

                for (const threadId of autoResolveThreadIds) {
                  const thread = byId.get(threadId);
                  if (!thread) {
                    skipped.push({ threadId, reason: 'missing_thread' });
                    continue;
                  }
                  if (thread.isOutdated) {
                    skipped.push({ threadId, reason: 'outdated_thread' });
                    continue;
                  }
                  const commentId = thread.comments[0]?.databaseId;
                  if (!commentId) {
                    skipped.push({ threadId, reason: 'missing_comment_id' });
                    continue;
                  }
                  try {
                    await replyToReviewComment({
                      pr: review.pr,
                      commentId,
                      body: reviewIntelligence.nitpickAcknowledgement,
                      token: githubToken,
                      bus: ctx.events.bus,
                      context: emitContext,
                    });
                    await resolveReviewThread({
                      threadId,
                      pr: review.pr,
                      token: githubToken,
                      bus: ctx.events.bus,
                      context: emitContext,
                    });
                    resolved.push(threadId);
                  } catch (error) {
                    const reason =
                      error instanceof Error ? error.message : 'failed_to_resolve';
                    failed.push({ threadId, reason });
                  }
                }
                return { resolved, skipped, failed };
              },
              {
                inputs: { count: autoResolveThreadIds.length },
                artifacts: (result) => ({ result }),
              },
            );
            resolvedAutoResolveIds = autoResolveResult.resolved;
            autoResolveFailures = autoResolveResult.failed;
            autoResolveSkipped = autoResolveResult.skipped;
          }
        }
      }

      if (autoResolveEnabled) {
        const resolvedSet = new Set(resolvedAutoResolveIds);
        const unresolvedAutoResolve = [
          ...autoResolveFailures.map((item) => item.threadId),
          ...autoResolveSkipped.map((item) => item.threadId),
        ];
        actionableThreadIds = [
          ...new Set([
            ...actionableThreadIds.filter((id) => !resolvedSet.has(id)),
            ...unresolvedAutoResolve,
          ]),
        ];
        ignoredThreadIds = ignoredThreadIds.filter((id) => !resolvedSet.has(id));
        await updateState(ctx, (data) => ({
          ...data,
          reviewClassificationSummary: {
            actionable: actionableThreadIds.length,
            ignored: ignoredThreadIds.length,
            needsContext: classification.needsContextThreadIds.length,
            severity: severitySummary,
            autoResolved: resolvedAutoResolveIds.length,
          },
          reviewAutoResolveSummary: {
            attempted: autoResolveThreadIds.length,
            resolved: resolvedAutoResolveIds.length,
            skipped: autoResolveSkipped.length,
            failed: autoResolveFailures.length,
            ...(autoResolveFailures.length > 0 ? { failures: autoResolveFailures } : {}),
            ...(autoResolveSkipped.length > 0 ? { skipped: autoResolveSkipped } : {}),
          },
        }));
      }

      const detailedThreads = threadsNeedingContext.length
        ? await runStep(
            ctx,
            'review.thread.fetch',
            'Fetch full review threads',
            async () => {
              const results: Array<{
                threadId: string;
                comments: Array<{
                  id: string;
                  path: string | null;
                  line: number | null;
                  body: string;
                  url?: string | null;
                }>;
                isOutdated: boolean;
              }> = [];

              for (const threadId of threadsNeedingContext) {
                const thread = await fetchReviewThreadById({
                  threadId,
                  token: githubToken,
                  bus: ctx.events.bus,
                  context: {
                    runId: ctx.runId,
                    repoRoot: ctx.repo.repoRoot,
                    mode: ctx.events.mode,
                  },
                });
                results.push({
                  threadId: thread.id,
                  isOutdated: thread.isOutdated,
                  comments: thread.comments.nodes.map((comment) => ({
                    id: comment.id,
                    databaseId: comment.databaseId ?? null,
                    path: comment.path,
                    line: comment.line,
                    body: comment.body,
                    url: comment.url ?? null,
                  })),
                });
              }
              return results;
            },
            {
              inputs: { threadCount: threadsNeedingContext.length },
              artifacts: (result) => ({ threads: result }),
            },
          )
        : [];

      const threadsForPlan = buildReviewPlanThreads({
        fingerprints: fingerprintList,
        detailedThreads,
        actionableThreadIds,
        ignoredThreadIds,
      });

      const fixPlan = await runStep(
        ctx,
        'review.plan',
        'Plan review fixes',
        () =>
          generateReviewFixPlan({
            threads: threadsForPlan,
            store: conversationStore,
            config: ctx.config,
            cacheDir: ctx.state.cacheDir,
            bus: ctx.events.bus,
            context: emitContext,
          }),
        {
          inputs: {
            actionable: actionableThreadIds.length,
            ignored: ignoredThreadIds.length,
          },
          artifacts: (result) => ({ plan: result }),
        },
      );

      await updateState(ctx, (data) => ({
        ...data,
        reviewFixPlanSummary: {
          actionable: fixPlan.threads.filter((thread) => thread.actionable).length,
          ignored: fixPlan.threads.filter((thread) => !thread.actionable).length,
        },
        reviewIteration: iteration + 1,
      }));

      const actionableThreads = fixPlan.threads.filter((thread) => thread.actionable);
      if (
        actionableThreads.length === 0 &&
        (!fixPlan.resolveThreads || fixPlan.resolveThreads.length === 0)
      ) {
        await updateState(ctx, (data) => ({
          ...data,
          summary: {
            ...(typeof data['summary'] === 'object' && data['summary']
              ? data['summary']
              : {}),
            blockedReason: 'No actionable review fixes identified.',
          },
        }));
        await recordArtifacts(ctx, 'review-iterations', {
          [`iteration-${iterationIndex}`]: {
            iteration: iterationIndex,
            status: 'blocked',
            reason: 'no_actionable_fixes',
            unresolvedBefore: review.comments.length,
            actionable: actionableThreads.length,
            ignored: fixPlan.threads.length - actionableThreads.length,
            generatedAt: new Date().toISOString(),
          },
        });
        throw new Error('No actionable review fixes identified; manual review required');
      }
      if (actionableThreads.length > 0) {
        const reviewPlan: Plan = {
          summary: 'Review fixes',
          steps: actionableThreads.map((thread) => ({
            id: thread.threadId,
            title: thread.summary,
            description: thread.summary,
          })),
          verification: fixPlan.verification ?? [],
        };
        const reviewPlanDigest = hashString(JSON.stringify(reviewPlan));
        await runStep(ctx, 'review.apply', 'Apply review fixes', () =>
          (async () => {
            const execPrompt = new ProseWriter();
            execPrompt.write('You are the implementation agent for Silvan.');
            execPrompt.write('Follow the plan step-by-step, using tools when needed.');
            execPrompt.write('Do not invent file contents; use fs.read before edits.');
            execPrompt.write('Keep changes minimal and aligned to the plan.');
            execPrompt.write(
              'Use silvan.plan.read to fetch the full plan before making edits.',
            );
            execPrompt.write('Return a brief summary of changes.');
            execPrompt.write(`Plan digest: ${reviewPlanDigest}`);

            const execSnapshot = await conversationStore.append({
              role: 'system',
              content: execPrompt.toString().trimEnd(),
              metadata: { kind: 'review' },
            });

            const result = await executePlan({
              snapshot: execSnapshot,
              model: execModel,
              repoRoot: worktreeRoot,
              config: ctx.config,
              dryRun: Boolean(options.dryRun),
              allowDestructive: Boolean(options.apply),
              allowDangerous: Boolean(options.dangerous),
              ...execBudgets,
              ...getToolBudget(ctx.config),
              ...(options.sessions ? { sessionPool: options.sessions } : {}),
              bus: ctx.events.bus,
              context: emitContext,
              state: ctx.state,
              heartbeat: () => heartbeatStep(ctx, 'review.apply'),
            });

            const execConversation = appendMessages(execSnapshot.conversation, {
              role: 'assistant',
              content: `Review fix summary: ${result}`,
              metadata: { kind: 'review', protected: true },
            });
            await conversationStore.save(execConversation);
            return result;
          })(),
        );

        const verifyReport = await runStep(
          ctx,
          'review.verify',
          'Verify review fixes',
          () => runVerifyCommands(ctx.config, { cwd: worktreeRoot }),
          { artifacts: (report) => ({ report }) },
        );
        await updateState(ctx, (data) => ({
          ...data,
          reviewVerifySummary: {
            ok: verifyReport.ok,
            lastRunAt: new Date().toISOString(),
          },
        }));
        if (!verifyReport.ok) {
          await recordVerificationAssist({
            ctx,
            report: verifyReport,
            context: 'review',
            emitContext,
          });
          throw new Error('Verification failed during review loop');
        }
      }

      let reviewCheckpointSha: string | undefined;
      if (actionableThreads.length > 0) {
        const reviewCheckpoint = await runStep(
          ctx,
          'review.checkpoint',
          'Checkpoint review fixes',
          () => createCheckpointCommit(ctx, `silvan: checkpoint review-${iteration + 1}`),
          {
            inputs: { iteration: iteration + 1 },
            artifacts: (result) => ({ checkpoint: result }),
          },
        );
        if (reviewCheckpoint?.sha) {
          reviewCheckpointSha = reviewCheckpoint.sha;
          await updateState(ctx, (data) => ({
            ...data,
            checkpoints: [
              ...((data['checkpoints'] as string[]) ?? []),
              reviewCheckpoint.sha,
            ],
            lastReviewCheckpoint: reviewCheckpoint.sha,
          }));
        }

        await runStep(ctx, 'review.push', 'Push review fixes', () =>
          runGit(['push', 'origin', headBranch], {
            cwd: worktreeRoot,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
          }),
        );

        const ciAfter = await runStep(ctx, 'ci.wait', 'Wait for CI', () =>
          waitForCi({
            owner,
            repo,
            headBranch,
            token: githubToken,
            pollIntervalMs: 15000,
            timeoutMs: 900000,
            onHeartbeat: () => heartbeatStep(ctx, 'ci.wait'),
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
        );
        finalCiState = ciAfter.state;
        await updateState(ctx, (data) => ({
          ...data,
          summary: {
            ...(typeof data['summary'] === 'object' && data['summary']
              ? data['summary']
              : {}),
            ci: ciAfter.state,
          },
        }));
        if (ciAfter.state === 'failing') {
          const flaky =
            reviewCheckpointSha &&
            priorCheckpoint &&
            reviewCheckpointSha === priorCheckpoint;
          await updateState(ctx, (data) => ({
            ...data,
            summary: {
              ...(typeof data['summary'] === 'object' && data['summary']
                ? data['summary']
                : {}),
              blockedReason: flaky
                ? 'CI failed without new changes (possible flake).'
                : 'CI failed during review loop.',
            },
          }));
          await recordArtifacts(ctx, 'review-iterations', {
            [`iteration-${iterationIndex}`]: {
              iteration: iterationIndex,
              status: 'blocked',
              reason: flaky ? 'ci_flaky' : 'ci_failed',
              unresolvedBefore: review.comments.length,
              actionable: actionableThreads.length,
              ignored: fixPlan.threads.length - actionableThreads.length,
              ciState: ciAfter.state,
              checkpointSha: reviewCheckpointSha ?? null,
              generatedAt: new Date().toISOString(),
            },
          });
          throw new Error(
            flaky
              ? 'CI failed without new changes (possible flake).'
              : 'CI failed during review loop',
          );
        }
      }

      if (fixPlan.resolveThreads?.length) {
        const resolvedState = await ctx.state.readRunState(ctx.runId);
        const resolvedData = (resolvedState?.data as Record<string, unknown>) ?? {};
        const resolvedThreads = new Set(
          Array.isArray(resolvedData['resolvedThreads'])
            ? (resolvedData['resolvedThreads'] as string[])
            : [],
        );
        for (const threadId of fixPlan.resolveThreads) {
          if (resolvedThreads.has(threadId)) continue;
          await runStep(ctx, 'review.resolve', 'Resolve review thread', () =>
            resolveReviewThread({
              threadId,
              pr: review.pr,
              token: githubToken,
              bus: ctx.events.bus,
              context: {
                runId: ctx.runId,
                repoRoot: ctx.repo.repoRoot,
                mode: ctx.events.mode,
              },
            }),
          );
          resolvedThreads.add(threadId);
          await updateState(ctx, (data) => ({
            ...data,
            resolvedThreads: Array.from(resolvedThreads),
          }));
        }
      }

      const reRequestKey = reviewRequestKey({
        prNumber: review.pr.number,
        reviewers: ctx.config.github.reviewers,
        requestCopilot: ctx.config.github.requestCopilot,
      });
      const reRequestKeyWithIteration = hashString(
        JSON.stringify({ key: reRequestKey, iteration: iteration + 1 }),
      );
      const latestState = await ctx.state.readRunState(ctx.runId);
      const latestData = (latestState?.data as Record<string, unknown>) ?? {};
      const existingReRequestKey =
        typeof latestData['reviewRequestKey'] === 'string'
          ? latestData['reviewRequestKey']
          : undefined;
      if (existingReRequestKey !== reRequestKeyWithIteration) {
        await runStep(ctx, 'github.review.request', 'Re-request reviewers', () =>
          requestReviewers({
            pr: review.pr,
            reviewers: ctx.config.github.reviewers,
            requestCopilot: ctx.config.github.requestCopilot,
            token: githubToken,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
        );
        await updateState(ctx, (data) => ({
          ...data,
          reviewRequestKey: reRequestKeyWithIteration,
        }));
      }

      const reviewAfter = await runStep(
        ctx,
        'github.review.fetch.post',
        'Refetch review comments',
        () =>
          fetchUnresolvedReviewComments({
            owner,
            repo,
            headBranch,
            token: githubToken,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
      );

      await updateState(ctx, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          unresolvedReviewCount: reviewAfter.comments.length,
        },
      }));

      const resolvedThreadsSnapshot = await ctx.state.readRunState(ctx.runId);
      const resolvedThreadsData =
        (resolvedThreadsSnapshot?.data as Record<string, unknown>) ?? {};
      const resolvedThreadsList = Array.isArray(resolvedThreadsData['resolvedThreads'])
        ? (resolvedThreadsData['resolvedThreads'] as string[])
        : [];

      await recordArtifacts(ctx, 'review-iterations', {
        [`iteration-${iterationIndex}`]: {
          iteration: iterationIndex,
          status: 'completed',
          unresolvedBefore: review.comments.length,
          unresolvedAfter: reviewAfter.comments.length,
          actionable: actionableThreads.length,
          ignored: fixPlan.threads.length - actionableThreads.length,
          ciState: finalCiState,
          checkpointSha: reviewCheckpointSha ?? null,
          resolvedThreads: resolvedThreadsList,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Review loop failed';
      await updateState(ctx, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          blockedReason: message,
        },
      }));
      throw error;
    }
  }
}

export async function runLearningNotes(
  ctx: RunContext,
  options?: { allowApply?: boolean },
): Promise<void> {
  const config = ctx.config.learning;
  if (!config.enabled) return;

  const state = await ctx.state.readRunState(ctx.runId);
  const data = getRunState((state?.data as Record<string, unknown>) ?? {});
  const emitContext = {
    runId: ctx.runId,
    repoRoot: ctx.repo.repoRoot,
    mode: ctx.events.mode,
  };
  const worktreeRoot = ctx.repo.worktreePath ?? ctx.repo.repoRoot;
  const conversationStore = createConversationStore({
    runId: ctx.runId,
    state: ctx.state,
    config: ctx.config,
    bus: ctx.events.bus,
    context: emitContext,
  });

  const task = data['task'] as Task | undefined;
  const planResult = planSchema.safeParse(data['plan']);
  const planSummary =
    planResult.success && planResult.data.summary ? planResult.data.summary : undefined;
  const summary =
    typeof data['summary'] === 'object' && data['summary']
      ? (data['summary'] as Record<string, unknown>)
      : {};
  const input = {
    ...(task
      ? { task: { key: task.key, title: task.title, provider: task.provider } }
      : {}),
    ...(planSummary ? { planSummary } : {}),
    ...(typeof data['implementationSummary'] === 'string'
      ? { implementationSummary: data['implementationSummary'] }
      : {}),
    ...(typeof data['verifySummary'] === 'object' && data['verifySummary']
      ? { verification: data['verifySummary'] as { ok?: boolean } }
      : {}),
    ...(typeof data['localGateSummary'] === 'object' && data['localGateSummary']
      ? { localGate: data['localGateSummary'] as { ok?: boolean } }
      : {}),
    ...(typeof data['reviewClassificationSummary'] === 'object' &&
    data['reviewClassificationSummary']
      ? {
          review: {
            unresolved:
              typeof summary['unresolvedReviewCount'] === 'number'
                ? summary['unresolvedReviewCount']
                : 0,
            actionable: (data['reviewClassificationSummary'] as { actionable?: number })
              .actionable,
          },
        }
      : {}),
    ...(typeof data['ciFixSummary'] === 'object' && data['ciFixSummary']
      ? { ciFixSummary: data['ciFixSummary'] as { summary?: string } }
      : {}),
    ...(typeof summary['blockedReason'] === 'string'
      ? { blockedReason: summary['blockedReason'] }
      : {}),
    ...(typeof summary['prUrl'] === 'string' ? { pr: { url: summary['prUrl'] } } : {}),
  } as import('../learning/notes').LearningInput;

  const baseBranch = ctx.config.github.baseBranch ?? ctx.config.repo.defaultBranch;
  const diffStat = await runGit(['diff', '--stat', `${baseBranch}...HEAD`], {
    cwd: worktreeRoot,
    bus: ctx.events.bus,
    context: emitContext,
  });
  if (diffStat.stdout.trim()) {
    input.diffStat = diffStat.stdout.trim();
  }

  const notesStep = getStepRecord(data, 'learning.notes');
  const existingDataEntry = getArtifactEntry(data, 'learning.notes', 'data');
  const existingNotes =
    notesStep?.status === 'done' && existingDataEntry
      ? await readArtifact<import('../learning/notes').LearningNotes>({
          entry: existingDataEntry,
        })
      : undefined;

  const notes =
    existingNotes ??
    (await runStep(
      ctx,
      'learning.notes',
      'Generate learning notes',
      () =>
        generateLearningNotes({
          input,
          store: conversationStore,
          config: ctx.config,
          cacheDir: ctx.state.cacheDir,
          bus: ctx.events.bus,
          context: emitContext,
        }),
      {
        inputs: { digest: hashString(JSON.stringify(input)) },
        artifacts: (result) => ({ data: result }),
      },
    ));

  const markdown = renderLearningMarkdown(ctx.runId, input, notes);
  const notesEntry = getArtifactEntry(data, 'learning.notes', 'notes');
  if (!notesEntry) {
    await recordArtifacts(ctx, 'learning.notes', {
      notes: markdown,
    });
  }

  const allowApply = options?.allowApply ?? true;
  const applyTargets = {
    ...(config.targets.rules ? { rules: config.targets.rules } : {}),
    ...(config.targets.skills ? { skills: config.targets.skills } : {}),
    ...(config.targets.docs ? { docs: config.targets.docs } : {}),
  };
  const targetCheck = evaluateLearningTargets({
    targets: applyTargets,
    worktreeRoot,
  });
  const hasItems = notes.rules.length + notes.skills.length + notes.docs.length > 0;
  const baseSummary = {
    summary: notes.summary,
    rules: notes.rules.length,
    skills: notes.skills.length,
    docs: notes.docs.length,
    mode: config.mode,
  };
  const updateLearningSummary = async (extra?: Record<string, unknown>) =>
    updateState(ctx, (prev) => ({
      ...prev,
      learningSummary: {
        ...(typeof prev['learningSummary'] === 'object' && prev['learningSummary']
          ? (prev['learningSummary'] as Record<string, unknown>)
          : {}),
        ...baseSummary,
        ...(extra ?? {}),
      },
    }));

  if (!hasItems) {
    await updateLearningSummary({ status: 'skipped', reason: 'no_items' });
    return;
  }

  const autoApplyConfig = config.autoApply;
  const shouldScore = autoApplyConfig.enabled;
  const shouldAutoApply = config.mode !== 'apply' && autoApplyConfig.enabled;
  const shouldApplyImmediately = config.mode === 'apply';
  const ciState = summary['ci'] as import('../events/schema').CiState | undefined;
  const unresolvedReviews =
    typeof summary['unresolvedReviewCount'] === 'number'
      ? summary['unresolvedReviewCount']
      : undefined;
  const aiReviewSummary = data['aiReviewSummary'] as { shipIt?: boolean } | undefined;

  const confidenceResult = shouldScore
    ? scoreLearningConfidence({
        notes,
        history: await loadLearningHistory({
          state: ctx.state,
          excludeRunId: ctx.runId,
          lookbackDays: autoApplyConfig.lookbackDays,
          maxEntries: autoApplyConfig.maxHistory,
        }),
        minSamples: autoApplyConfig.minSamples,
        threshold: autoApplyConfig.threshold,
        ...(ciState ? { ci: ciState } : {}),
        ...(typeof unresolvedReviews === 'number' ? { unresolvedReviews } : {}),
        ...(typeof aiReviewSummary?.shipIt === 'boolean'
          ? { aiReviewShipIt: aiReviewSummary.shipIt }
          : {}),
      })
    : undefined;

  if (shouldApplyImmediately) {
    if (!allowApply) {
      const request: LearningRequest = {
        id: ctx.runId,
        runId: ctx.runId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        summary: notes.summary,
        confidence: confidenceResult?.confidence ?? 0,
        threshold: confidenceResult?.threshold ?? autoApplyConfig.threshold,
        notes,
        targets: applyTargets,
        reason: 'apply_disabled',
      };
      await writeLearningRequest({ state: ctx.state, request });
      await updateLearningSummary({
        status: 'pending',
        confidence: request.confidence,
        threshold: request.threshold,
        decisionReason: request.reason,
      });
      return;
    }

    if (!targetCheck.ok) {
      const request: LearningRequest = {
        id: ctx.runId,
        runId: ctx.runId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        summary: notes.summary,
        confidence: confidenceResult?.confidence ?? 0,
        threshold: confidenceResult?.threshold ?? autoApplyConfig.threshold,
        notes,
        targets: applyTargets,
        reason: `unsafe_targets: ${targetCheck.reasons.join('; ')}`,
      };
      await writeLearningRequest({ state: ctx.state, request });
      await updateLearningSummary({
        status: 'pending',
        confidence: request.confidence,
        threshold: request.threshold,
        decisionReason: request.reason,
      });
      return;
    }

    const applyStep = getStepRecord(data, 'learning.apply');
    if (applyStep?.status !== 'done') {
      const applyResult = await runStep(
        ctx,
        'learning.apply',
        'Apply learning updates',
        () =>
          applyLearningNotes({
            runId: ctx.runId,
            worktreeRoot,
            notes,
            targets: applyTargets,
          }),
        { artifacts: (result) => ({ result }) },
      );
      const commitResult = await commitLearningNotes({
        ctx,
        worktreeRoot,
        runId: ctx.runId,
        appliedTo: applyResult.appliedTo,
        message: `silvan: apply learnings (${ctx.runId})`,
      });
      const appliedAt = new Date().toISOString();
      await updateLearningSummary({
        status: 'applied',
        appliedTo: applyResult.appliedTo,
        appliedAt,
        commitSha: commitResult.sha,
        autoApplied: true,
      });
      await writeLearningRequest({
        state: ctx.state,
        request: {
          id: ctx.runId,
          runId: ctx.runId,
          status: 'applied',
          createdAt: appliedAt,
          updatedAt: appliedAt,
          summary: notes.summary,
          confidence: confidenceResult?.confidence ?? 1,
          threshold: confidenceResult?.threshold ?? autoApplyConfig.threshold,
          notes,
          targets: applyTargets,
          appliedAt,
          appliedTo: applyResult.appliedTo,
          ...(commitResult.sha ? { commitSha: commitResult.sha } : {}),
          reason: 'mode_apply',
        },
      });
    }
    return;
  }

  if (!shouldAutoApply) {
    await updateLearningSummary({ status: 'recorded' });
    return;
  }

  const confidence = confidenceResult?.confidence ?? 0;
  const threshold = confidenceResult?.threshold ?? autoApplyConfig.threshold;
  const belowThreshold = confidence < threshold;
  const applyBlockedReason = !allowApply
    ? 'apply_disabled'
    : !targetCheck.ok
      ? `unsafe_targets: ${targetCheck.reasons.join('; ')}`
      : belowThreshold
        ? 'below_threshold'
        : undefined;

  if (applyBlockedReason) {
    const request: LearningRequest = {
      id: ctx.runId,
      runId: ctx.runId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      summary: notes.summary,
      confidence,
      threshold,
      notes,
      targets: applyTargets,
      reason: applyBlockedReason,
    };
    await writeLearningRequest({ state: ctx.state, request });
    await updateLearningSummary({
      status: 'pending',
      confidence,
      threshold,
      decisionReason: applyBlockedReason,
      ...(confidenceResult?.breakdown
        ? { confidenceBreakdown: confidenceResult.breakdown }
        : {}),
    });
    return;
  }

  const autoApplyStep = getStepRecord(data, 'learning.auto_apply');
  if (autoApplyStep?.status === 'done') {
    await updateLearningSummary({
      status: 'applied',
      confidence,
      threshold,
      autoApplied: true,
      ...(confidenceResult?.breakdown
        ? { confidenceBreakdown: confidenceResult.breakdown }
        : {}),
    });
    return;
  }

  const applyResult = await runStep(
    ctx,
    'learning.auto_apply',
    'Auto-apply learning updates',
    () =>
      applyLearningNotes({
        runId: ctx.runId,
        worktreeRoot,
        notes,
        targets: applyTargets,
      }),
    { artifacts: (result) => ({ result }) },
  );
  const commitResult = await commitLearningNotes({
    ctx,
    worktreeRoot,
    runId: ctx.runId,
    appliedTo: applyResult.appliedTo,
    message: `silvan: apply learnings (${ctx.runId})`,
  });
  const appliedAt = new Date().toISOString();
  await updateLearningSummary({
    status: 'applied',
    appliedTo: applyResult.appliedTo,
    appliedAt,
    commitSha: commitResult.sha,
    autoApplied: true,
    confidence,
    threshold,
    ...(confidenceResult?.breakdown
      ? { confidenceBreakdown: confidenceResult.breakdown }
      : {}),
  });
  await writeLearningRequest({
    state: ctx.state,
    request: {
      id: ctx.runId,
      runId: ctx.runId,
      status: 'applied',
      createdAt: appliedAt,
      updatedAt: appliedAt,
      summary: notes.summary,
      confidence,
      threshold,
      notes,
      targets: applyTargets,
      appliedAt,
      appliedTo: applyResult.appliedTo,
      ...(commitResult.sha ? { commitSha: commitResult.sha } : {}),
      reason: 'auto_apply',
    },
  });
}

export async function runRecovery(ctx: RunContext): Promise<void> {
  const state = await ctx.state.readRunState(ctx.runId);
  const data = (state?.data as Record<string, unknown>) ?? {};
  const worktreeRoot = ctx.repo.worktreePath ?? ctx.repo.repoRoot;
  const emitContext = {
    runId: ctx.runId,
    repoRoot: ctx.repo.repoRoot,
    mode: ctx.events.mode,
  };
  const conversationStore = createConversationStore({
    runId: ctx.runId,
    state: ctx.state,
    config: ctx.config,
    bus: ctx.events.bus,
    context: emitContext,
  });
  const plan = await runStep(
    ctx,
    'agent.recovery.plan',
    'Plan recovery',
    () =>
      generateRecoveryPlan({
        runState: data,
        store: conversationStore,
        config: ctx.config,
        cacheDir: ctx.state.cacheDir,
        bus: ctx.events.bus,
        context: emitContext,
      }),
    {
      artifacts: (result) => ({ plan: result }),
    },
  );
  await updateState(ctx, (prev) => ({
    ...prev,
    recoverySummary: {
      nextAction: plan.nextAction,
      reason: plan.reason,
    },
  }));

  switch (plan.nextAction) {
    case 'rerun_verification': {
      await changePhase(ctx, 'verify', 'recovery');
      const verifyReport = await runStep(
        ctx,
        'recovery.verify',
        'Rerun verification',
        () => runVerifyCommands(ctx.config, { cwd: worktreeRoot }),
        { artifacts: (report) => ({ report }) },
      );
      await updateState(ctx, (prev) => ({
        ...prev,
        recoveryResult: {
          action: plan.nextAction,
          verifySummary: {
            ok: verifyReport.ok,
            lastRunAt: new Date().toISOString(),
          },
        },
      }));
      if (!verifyReport.ok) {
        await recordVerificationAssist({
          ctx,
          report: verifyReport,
          context: 'recovery',
          emitContext,
        });
        throw new Error('Verification failed during recovery');
      }
      return;
    }
    case 'refetch_reviews': {
      await changePhase(ctx, 'review', 'recovery');
      const githubToken = requireGitHubAuth(ctx.config);
      const github = await requireGitHubConfig({
        config: ctx.config,
        repoRoot: ctx.repo.repoRoot,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
        bus: ctx.events.bus,
      });
      const review = await runStep(
        ctx,
        'recovery.review.fetch',
        'Refetch review comments',
        () =>
          fetchUnresolvedReviewComments({
            owner: github.owner,
            repo: github.repo,
            headBranch: ctx.repo.branch,
            token: githubToken,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
      );
      await updateState(ctx, (prev) => ({
        ...prev,
        recoveryResult: {
          action: plan.nextAction,
          reviewSummary: {
            pr: review.pr,
            unresolvedCount: review.comments.length,
          },
        },
      }));
      return;
    }
    case 'restart_review_loop': {
      if (!ctx.config.features.autoMode) {
        throw new Error(
          'Recovery suggests restarting the review loop. Re-run with auto mode.',
        );
      }
      await runReviewLoop(ctx, { apply: true });
      return;
    }
    case 'ask_user':
    default:
      throw new Error('Recovery requires user input before continuing');
  }
}

export async function resumeRun(
  ctx: RunContext,
  options: RunControllerOptions,
): Promise<void> {
  const state = await ctx.state.readRunState(ctx.runId);
  if (!state) {
    throw new Error(`Run not found: ${ctx.runId}`);
  }
  const data = getRunState(state.data);
  const run = data.run;
  const steps = data.steps ?? {};

  for (const [stepId, step] of Object.entries(steps)) {
    if (step.status === 'running' && isLeaseStale(step.lease)) {
      await updateState(ctx, (prev) => {
        const nextSteps = { ...(prev['steps'] as Record<string, StepRecord>) };
        nextSteps[stepId] = {
          ...step,
          status: 'failed',
          endedAt: new Date().toISOString(),
          error: toEventError(new Error('Step lease stale; assuming crash.')),
        };
        return { ...prev, steps: nextSteps };
      });
    }
  }

  if (!data['plan'] || run?.phase === 'plan' || run?.phase === 'idle') {
    const taskRef =
      typeof data['taskRef'] === 'object' && data['taskRef']
        ? (data['taskRef'] as { raw?: string }).raw
        : undefined;
    const task = data['task'];
    const taskId =
      typeof task === 'object' && task && 'id' in task
        ? (task as { id?: string }).id
        : undefined;
    await runPlanner(ctx, {
      ...(taskRef ? { taskRef } : taskId ? { taskRef: taskId } : {}),
      ...(options.sessions ? { sessions: options.sessions } : {}),
    });
    return;
  }

  if (run?.phase === 'implement' || run?.phase === 'verify' || run?.phase === 'pr') {
    const shouldReview = await runImplementation(ctx, options);
    if (!shouldReview) {
      return;
    }
    return;
  }

  if (run?.phase === 'review') {
    await runReviewLoop(ctx, options);
    return;
  }

  if (run?.phase === 'complete') {
    return;
  }

  await runRecovery(ctx);
}
