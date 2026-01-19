import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import { executePlan } from '../agent/executor';
import { type Plan, planSchema } from '../agent/schemas';
import type { SessionPool } from '../agent/session';
import { generateCiFixPlan } from '../ai/cognition/ci-triager';
import { generateExecutionKickoffPrompt } from '../ai/cognition/kickoff';
import { generatePlan } from '../ai/cognition/planner';
import { draftPullRequest } from '../ai/cognition/pr-writer';
import { generateRecoveryPlan } from '../ai/cognition/recovery';
import { classifyReviewThreads } from '../ai/cognition/review-classifier';
import { generateReviewRemediationKickoffPrompt } from '../ai/cognition/review-kickoff';
import { generateReviewFixPlan } from '../ai/cognition/reviewer';
import { decideVerification } from '../ai/cognition/verifier';
import { createConversationStore } from '../ai/conversation';
import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import { createEnvelope, toEventError } from '../events/emit';
import type { Phase, RunPhaseChanged, RunStep } from '../events/schema';
import { runGit } from '../git/exec';
import { waitForCi } from '../github/ci';
import { openOrUpdatePr, requestReviewers } from '../github/pr';
import {
  fetchReviewThreadById,
  fetchUnresolvedReviewComments,
  resolveReviewThread,
} from '../github/review';
import {
  applyLearningNotes,
  generateLearningNotes,
  renderLearningMarkdown,
} from '../learning/notes';
import { hashPrompt, renderPromptSummary } from '../prompts';
import { runAiReviewer } from '../review/ai-reviewer';
import { formatLocalGateSummary, generateLocalGateReport } from '../review/local-gate';
import {
  buildReviewPlanThreads,
  type ReviewThreadFingerprint,
  selectThreadsForContext,
} from '../review/planning';
import { type ArtifactEntry, readArtifact, writeArtifact } from '../state/artifacts';
import {
  commentOnPrOpen,
  completeTask,
  moveTaskToInProgress,
  moveTaskToInReview,
} from '../task/lifecycle';
import { resolveTask } from '../task/resolve';
import type { Task } from '../task/types';
import { hashString } from '../utils/hash';
import { runVerifyCommands } from '../verify/run';
import { triageVerificationFailures } from '../verify/triage';
import type { RunContext } from './context';
import { SilvanError } from './errors';

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
  const verifyReport =
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

    const triage = triageVerificationFailures(results);
    const decision = await runStep(
      ctx,
      'verify.decide',
      'Decide verification next steps',
      async () => {
        if (options.apply && !triage.classified) {
          return decideVerification({
            report: {
              ok: verifyReport.ok,
              results,
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
          commandCount: results.length,
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
  const requestKey = reviewRequestKey({
    prNumber: prResult.pr.number,
    reviewers: ctx.config.github.reviewers,
    requestCopilot: ctx.config.github.requestCopilot,
  });
  const existingRequestKey =
    typeof data['reviewRequestKey'] === 'string' ? data['reviewRequestKey'] : undefined;
  if (reviewStep?.status !== 'done' || existingRequestKey !== requestKey) {
    await runStep(ctx, 'github.review.request', 'Request reviewers', () =>
      requestReviewers({
        pr: prResult.pr,
        reviewers: ctx.config.github.reviewers,
        requestCopilot: ctx.config.github.requestCopilot,
        token: githubToken,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );
    await updateState(ctx, (data) => ({ ...data, reviewRequestKey: requestKey }));
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

      await updateState(ctx, (data) => ({
        ...data,
        reviewClassificationSummary: {
          actionable: classification.actionableThreadIds.length,
          ignored: classification.ignoredThreadIds.length,
          needsContext: classification.needsContextThreadIds.length,
        },
      }));
      const fingerprintList = Object.values(threadFingerprints);
      const threadsNeedingContext = selectThreadsForContext({
        fingerprints: fingerprintList,
        needsContextThreadIds: classification.needsContextThreadIds,
      });

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
        actionableThreadIds: classification.actionableThreadIds,
        ignoredThreadIds: classification.ignoredThreadIds,
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
            actionable: classification.actionableThreadIds.length,
            ignored: classification.ignoredThreadIds.length,
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

export async function runLearningNotes(ctx: RunContext): Promise<void> {
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

  await updateState(ctx, (prev) => ({
    ...prev,
    learningSummary: {
      summary: notes.summary,
      rules: notes.rules.length,
      skills: notes.skills.length,
      docs: notes.docs.length,
      mode: config.mode,
    },
  }));

  if (config.mode === 'apply') {
    const applyStep = getStepRecord(data, 'learning.apply');
    if (applyStep?.status !== 'done') {
      const applyTargets = {
        ...(config.targets.rules ? { rules: config.targets.rules } : {}),
        ...(config.targets.skills ? { skills: config.targets.skills } : {}),
        ...(config.targets.docs ? { docs: config.targets.docs } : {}),
      };
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
      await updateState(ctx, (prev) => ({
        ...prev,
        learningSummary: {
          ...(typeof prev['learningSummary'] === 'object' && prev['learningSummary']
            ? (prev['learningSummary'] as Record<string, unknown>)
            : {}),
          applied: true,
          appliedTo: applyResult.appliedTo,
        },
      }));
    }
  }
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
