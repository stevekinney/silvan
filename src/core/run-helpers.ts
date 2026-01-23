import { relative } from 'node:path';

import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import { executePlan } from '../agent/executor';
import type { Plan } from '../agent/schemas';
import type { SessionPool } from '../agent/session';
import { suggestVerificationRecovery } from '../ai/cognition/assist';
import { generateVerificationFixPlan } from '../ai/cognition/verification-fix';
import { createConversationStore } from '../ai/conversation';
import { createEnvelope, type EmitContext, toEventError } from '../events/emit';
import type { Phase, RunPhaseChanged, RunStep } from '../events/schema';
import { runGit } from '../git/exec';
import type { ArtifactEntry } from '../state/artifacts';
import { writeArtifact } from '../state/artifacts';
import type { Task } from '../task/types';
import { hashString } from '../utils/hash';
import { shouldAttemptVerificationAutoFix } from '../verify/auto-fix';
import { runVerifyCommands, type VerifyResult } from '../verify/run';
import type { RunContext } from './context';
import { createLogger } from './logger';

export type RunControllerOptions = {
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

export type RunStatus = 'running' | 'canceled' | 'failed' | 'success';

export type RunMeta = {
  version: '1.0.0';
  status: RunStatus;
  phase: Phase;
  step?: string;
  attempt: number;
  updatedAt: string;
};

export type StepStatus = 'not_started' | 'running' | 'done' | 'failed';

export type StepRecord = {
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
  inputsDigest?: string;
  outputsDigest?: string;
  artifacts?: Record<string, ArtifactEntry>;
  error?: ReturnType<typeof toEventError>;
  lease?: { leaseId: string; startedAt: string; heartbeatAt: string };
};

export type RunStateData = Record<string, unknown> & {
  run?: RunMeta;
  steps?: Record<string, StepRecord>;
  artifactsIndex?: Record<string, Record<string, ArtifactEntry>>;
};

const leaseStaleMs = 2 * 60 * 1000;

type ModelPhase = 'plan' | 'execute' | 'review' | 'pr' | 'recovery' | 'verify';

export function getModelForPhase(
  config: RunContext['config'],
  phase: ModelPhase,
): string {
  const models = config.ai.models;
  return models[phase] ?? models.default ?? 'claude-sonnet-4-5-20250929';
}

export function getBudgetsForPhase(
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

export async function recordVerificationAssist(options: {
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

export async function attemptVerificationAutoFix(options: {
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

export function getToolBudget(config: RunContext['config']): {
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

export function getRunState(data: Record<string, unknown>): RunStateData {
  return data as RunStateData;
}

export function getStepRecord(
  data: RunStateData,
  stepId: string,
): StepRecord | undefined {
  return data.steps?.[stepId];
}

export function getArtifactEntry(
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

export async function recordArtifacts(
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

export function isLeaseStale(lease?: StepRecord['lease']): boolean {
  if (!lease?.heartbeatAt) return false;
  const last = new Date(lease.heartbeatAt).getTime();
  return Date.now() - last > leaseStaleMs;
}

export function reviewRequestKey(options: {
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

export async function createCheckpointCommit(
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

export async function commitLearningNotes(options: {
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

export async function updateState(
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

export async function changePhase(
  ctx: RunContext,
  to: Phase,
  reason?: string,
): Promise<void> {
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

export async function runStep<T>(
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

export async function heartbeatStep(ctx: RunContext, stepId: string): Promise<void> {
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
