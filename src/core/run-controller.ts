import { generateCiFixPlan } from '../agent/ci-triager';
import { executePlan } from '../agent/executor';
import { generatePlan } from '../agent/planner';
import { draftPullRequest } from '../agent/pr-writer';
import { generateRecoveryPlan } from '../agent/recovery';
import { createToolRegistry } from '../agent/registry';
import { generateReviewFixPlan } from '../agent/reviewer';
import { type Plan, planSchema } from '../agent/schemas';
import type { SessionPool } from '../agent/session';
import { decideVerification } from '../agent/verifier';
import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import { createEnvelope, toEventError } from '../events/emit';
import type { Phase, RunPhaseChanged, RunStep } from '../events/schema';
import { runGit } from '../git/exec';
import { waitForCi } from '../github/ci';
import { openOrUpdatePr, requestReviewers } from '../github/pr';
import { fetchUnresolvedReviewComments, resolveReviewThread } from '../github/review';
import { fetchLinearTicket, moveLinearTicket, type LinearTicket } from '../linear/linear';
import { hashString } from '../utils/hash';
import { runVerifyCommands } from '../verify/run';
import { triageVerificationFailures } from '../verify/triage';
import type { RunContext } from './context';

type RunControllerOptions = {
  ticketId?: string;
  worktreeName?: string;
  clarifications?: Record<string, string>;
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
  artifacts?: Record<string, unknown>;
  error?: ReturnType<typeof toEventError>;
  lease?: { leaseId: string; startedAt: string; heartbeatAt: string };
};

type RunStateData = Record<string, unknown> & {
  run?: RunMeta;
  steps?: Record<string, StepRecord>;
};

const leaseStaleMs = 2 * 60 * 1000;

type ModelPhase = 'plan' | 'execute' | 'review' | 'pr' | 'recovery' | 'verify';

function getModelForPhase(phase: ModelPhase): string {
  const key = `SILVAN_MODEL_${phase.toUpperCase()}` as const;
  return Bun.env[key] ?? Bun.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-5-20250929';
}

function getBudgetsForPhase(phase: ModelPhase): {
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
} {
  const suffix = phase.toUpperCase();
  const maxTurns =
    Bun.env[`SILVAN_MAX_TURNS_${suffix}`] ?? Bun.env['SILVAN_MAX_TURNS'];
  const maxBudgetUsd =
    Bun.env[`SILVAN_MAX_BUDGET_USD_${suffix}`] ??
    Bun.env['SILVAN_MAX_BUDGET_USD'];
  const maxThinkingTokens =
    Bun.env[`SILVAN_MAX_THINKING_TOKENS_${suffix}`] ??
    Bun.env['SILVAN_MAX_THINKING_TOKENS'];

  return {
    ...(maxTurns ? { maxTurns: Number(maxTurns) } : {}),
    ...(maxBudgetUsd ? { maxBudgetUsd: Number(maxBudgetUsd) } : {}),
    ...(maxThinkingTokens ? { maxThinkingTokens: Number(maxThinkingTokens) } : {}),
  };
}

function getRunState(data: Record<string, unknown>): RunStateData {
  return data as RunStateData;
}

function getStepRecord(
  data: RunStateData,
  stepId: string,
): StepRecord | undefined {
  return data.steps?.[stepId];
}

function isLeaseStale(lease?: StepRecord['lease']): boolean {
  if (!lease?.heartbeatAt) return false;
  const last = new Date(lease.heartbeatAt).getTime();
  return Date.now() - last > leaseStaleMs;
}

async function createCheckpointCommit(
  ctx: RunContext,
  message: string,
): Promise<{ committed: boolean; sha?: string }> {
  await runGit(['add', '-A'], {
    cwd: ctx.repo.repoRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
  });

  const diff = await runGit(['diff', '--cached', '--quiet'], {
    cwd: ctx.repo.repoRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
  });

  if (diff.exitCode === 0) {
    return { committed: false };
  }

  const commit = await runGit(['commit', '-m', message], {
    cwd: ctx.repo.repoRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
  });

  if (commit.exitCode !== 0) {
    throw new Error(commit.stderr || 'Failed to create checkpoint commit');
  }

  const shaResult = await runGit(['rev-parse', 'HEAD'], {
    cwd: ctx.repo.repoRoot,
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
    const existingRun =
      typeof data['run'] === 'object' && data['run'] ? data['run'] : {};
    const run = existingRun as Partial<RunMeta>;
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
      steps:
        typeof data['steps'] === 'object' && data['steps'] ? data['steps'] : {},
    });
    const nextRun =
      typeof next['run'] === 'object' && next['run'] ? (next['run'] as RunMeta) : null;
    return {
      ...next,
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
    options?.inputs !== undefined ? hashString(JSON.stringify(options.inputs)) : undefined;

  await updateState(ctx, (prev) => {
    const steps = (prev['steps'] as Record<string, StepRecord>) ?? {};
    const existing = steps[stepId] ?? { status: 'not_started' };
    return {
      ...prev,
      run: {
        ...(typeof prev['run'] === 'object' && prev['run'] ? (prev['run'] as RunMeta) : {}),
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
    await updateState(ctx, (prev) => {
      const steps = (prev['steps'] as Record<string, StepRecord>) ?? {};
      const existing = steps[stepId] ?? { status: 'not_started' };
      return {
        ...prev,
        run: {
          ...(typeof prev['run'] === 'object' && prev['run'] ? (prev['run'] as RunMeta) : {}),
          step: undefined,
        },
        steps: {
          ...steps,
          [stepId]: {
            ...existing,
            status: 'done',
            endedAt,
            outputsDigest,
            ...(options?.artifacts ? { artifacts: options.artifacts(result) } : {}),
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
        payload: { stepId, title, status: 'succeeded' } satisfies RunStep,
      }),
    );
    return result;
  } catch (error) {
    const endedAt = new Date().toISOString();
    await updateState(ctx, (prev) => {
      const steps = (prev['steps'] as Record<string, StepRecord>) ?? {};
      const existing = steps[stepId] ?? { status: 'not_started' };
      return {
        ...prev,
        run: {
          ...(typeof prev['run'] === 'object' && prev['run'] ? (prev['run'] as RunMeta) : {}),
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
  const model = getModelForPhase('plan');
  const planBudgets = getBudgetsForPhase('plan');
  const planSession = options.sessions?.get('plan', {
    model,
    permissionMode: 'plan',
  });

  const plan = await runStep(ctx, 'agent.plan.generate', 'Generate plan', () =>
    generatePlan({
      ...(options.ticketId ? { ticketId: options.ticketId } : {}),
      ...(options.worktreeName ? { worktreeName: options.worktreeName } : {}),
      repoRoot: ctx.repo.repoRoot,
      model,
      ...planBudgets,
      ...(options.clarifications ? { clarifications: options.clarifications } : {}),
      ...(planSession ? { session: planSession } : {}),
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    }),
  );

  const ticket = options.ticketId ? await fetchLinearTicket(options.ticketId) : undefined;
  await updateState(ctx, (data) => ({
    ...data,
    plan,
    ticket,
    ...(options.clarifications ? { clarifications: options.clarifications } : {}),
    summary: {
      ...(typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}),
      planDigest: hashString(JSON.stringify(plan)),
    },
  }));

  const hasRequiredQuestions = plan.questions?.some(
    (question) => question.required !== false,
  );
  if (hasRequiredQuestions) {
    throw new Error('Clarifications required before execution.');
  }

  return plan;
}

export async function runImplementation(ctx: RunContext, options: RunControllerOptions) {
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
  const execModel = getModelForPhase('execute');
  const verifyModel = getModelForPhase('verify');
  const prModel = getModelForPhase('pr');
  const execBudgets = getBudgetsForPhase('execute');
  const verifyBudgets = getBudgetsForPhase('verify');
  const prBudgets = getBudgetsForPhase('pr');
  const ticket = (data['ticket'] as LinearTicket | undefined) ?? undefined;
  const linearStates = ctx.config.linear.states;
  const inProgress = linearStates?.inProgress;
  const inReview = linearStates?.inReview;
  if (ctx.config.linear.enabled && ticket?.identifier && inProgress) {
    const moveStep = getStepRecord(data, 'linear.ticket.move_in_progress');
    if (moveStep?.status !== 'done') {
      await runStep(ctx, 'linear.ticket.move_in_progress', 'Move ticket to In Progress', () =>
        moveLinearTicket(ticket.identifier, inProgress),
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
      : await runStep(ctx, 'agent.execute', 'Execute plan', () =>
          executePlan({
            model: execModel,
            repoRoot: ctx.repo.repoRoot,
            config: ctx.config,
            dryRun: Boolean(options.dryRun),
            allowDestructive: Boolean(options.apply),
            allowDangerous: Boolean(options.dangerous),
            planDigest,
            ...(options.sessions ? { sessionPool: options.sessions } : {}),
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
            state: ctx.state,
            ...execBudgets,
            ...(() => {
              const maxCalls = Bun.env['SILVAN_MAX_TOOL_CALLS'];
              const maxDurationMs = Bun.env['SILVAN_MAX_TOOL_MS'];
              if (!maxCalls && !maxDurationMs) return {};
              return {
                toolBudget: {
                  ...(maxCalls ? { maxCalls: Number(maxCalls) } : {}),
                  ...(maxDurationMs ? { maxDurationMs: Number(maxDurationMs) } : {}),
                },
              };
            })(),
            heartbeat: () => heartbeatStep(ctx, 'agent.execute'),
            toolCallLog,
          }),
          { inputs: { planDigest } },
        );

  await updateState(ctx, (data) => ({
    ...data,
    implementationSummary: summary,
    toolCalls: toolCallLog,
  }));

  await runStep(
    ctx,
    'git.checkpoint',
    'Checkpoint implementation',
    () => createCheckpointCommit(ctx, 'silvan: checkpoint implement'),
    {
      inputs: { phase: 'implement' },
      artifacts: (result) => ({ checkpoint: result }),
    },
  );

  await changePhase(ctx, 'verify');
  const verifyStep = getStepRecord(data, 'verify.run');
  const existingVerify = data['verifyReport'];
  const verifyReport =
    verifyStep?.status === 'done' &&
    typeof existingVerify === 'object' &&
    existingVerify &&
    (existingVerify as { ok?: boolean }).ok === true
      ? (existingVerify as { ok: boolean; results: unknown[] })
      : await runStep(ctx, 'verify.run', 'Run verification', () =>
          runVerifyCommands(ctx.config, { cwd: ctx.repo.repoRoot }),
        );
  await updateState(ctx, (data) => ({ ...data, verifyReport }));

  if (!verifyReport.ok) {
    const results = (verifyReport.results as Array<{
      name: string;
      exitCode: number;
      stderr: string;
    }>).map((result) => ({
      name: result.name,
      exitCode: result.exitCode,
      stderr: result.stderr,
    }));

    const triage = triageVerificationFailures(results);
    let decision = triage.decision;

    if (options.apply && !triage.classified) {
      const verifySession = options.sessions?.get('verify', {
        model: verifyModel,
        permissionMode: 'plan',
      });
      decision = await decideVerification({
        model: verifyModel,
        report: {
          ok: verifyReport.ok,
          results,
        },
        ...verifyBudgets,
        ...(verifySession ? { session: verifySession } : {}),
        ...(ctx.events.bus ? { bus: ctx.events.bus } : {}),
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      });
    }

    await updateState(ctx, (data) => ({ ...data, verificationDecision: decision }));
    throw new Error('Verification failed');
  }

  await changePhase(ctx, 'pr');
  requireGitHubAuth();
  const planSummary = plan.summary ?? 'Plan';
  const ticketUrl = ticket?.url;
  const prSession = options.sessions?.get('pr', {
    model: prModel,
    permissionMode: 'plan',
  });
  const prDraftStep = getStepRecord(data, 'pr.draft');
  const existingDraft =
    typeof data['prDraft'] === 'object' && data['prDraft']
      ? (data['prDraft'] as { title: string; body: string })
      : undefined;
  const prDraft =
    prDraftStep?.status === 'done' && existingDraft
      ? existingDraft
      : await runStep(ctx, 'pr.draft', 'Draft PR description', () =>
          draftPullRequest({
            model: prModel,
            planSummary,
            changesSummary: summary,
            ...prBudgets,
            ...(ticketUrl ? { ticketUrl } : {}),
            ...(prSession ? { session: prSession } : {}),
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
          }),
        );
  await updateState(ctx, (data) => ({ ...data, prDraft }));

  const github = await requireGitHubConfig({
    config: ctx.config,
    repoRoot: ctx.repo.repoRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    bus: ctx.events.bus,
  });
  const { owner, repo } = github;
  const headBranch = ctx.repo.branch;
  const baseBranch = ctx.config.github.baseBranch ?? ctx.config.repo.defaultBranch;
  const prStep = getStepRecord(data, 'github.pr.open');
  const existingPr =
    typeof data['pr'] === 'object' && data['pr']
      ? (data['pr'] as { pr: { url?: string; number: number; owner: string; repo: string } })
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
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
          }),
        );
  await updateState(ctx, (data) => ({ ...data, pr: prResult }));

  if (ctx.config.linear.enabled && ticket?.identifier && inReview) {
    const moveStep = getStepRecord(data, 'linear.ticket.move_in_review');
    if (moveStep?.status !== 'done') {
      await runStep(ctx, 'linear.ticket.move_in_review', 'Move ticket to In Review', () =>
        moveLinearTicket(ticket.identifier, inReview),
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
        ...(typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}),
        ci: ciResult.state,
      },
    }));
    if (ciResult.state === 'failing') {
      throw new Error('CI failed before review request');
    }
  }
  const reviewStep = getStepRecord(data, 'github.review.request');
  if (reviewStep?.status !== 'done') {
    await runStep(ctx, 'github.review.request', 'Request reviewers', () =>
      requestReviewers({
        pr: prResult.pr,
        reviewers: ctx.config.github.reviewers,
        requestCopilot: ctx.config.github.requestCopilot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );
  }

  await updateState(ctx, (data) => ({ ...data, prDraft, pr: prResult.pr }));
  return prResult.pr;
}

export async function runReviewLoop(ctx: RunContext, options: RunControllerOptions) {
  await changePhase(ctx, 'review');
  requireGitHubAuth();
  const execModel = getModelForPhase('execute');
  const reviewModel = getModelForPhase('review');
  const verifyModel = getModelForPhase('verify');
  const execBudgets = getBudgetsForPhase('execute');
  const reviewBudgets = getBudgetsForPhase('review');
  const verifyBudgets = getBudgetsForPhase('verify');
  const headBranch = ctx.repo.branch;
  const github = await requireGitHubConfig({
    config: ctx.config,
    repoRoot: ctx.repo.repoRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    bus: ctx.events.bus,
  });
  const { owner, repo } = github;
  const maxIterations = Number(Bun.env['SILVAN_MAX_REVIEW_LOOPS'] ?? 3);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const ciResult = await runStep(ctx, 'ci.wait.review', 'Wait for CI', () =>
      waitForCi({
        owner,
        repo,
        headBranch,
        pollIntervalMs: 15000,
        timeoutMs: 900000,
        onHeartbeat: () => heartbeatStep(ctx, 'ci.wait.review'),
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );

    await updateState(ctx, (data) => ({
      ...data,
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}),
        ci: ciResult.state,
      },
    }));

    if (ciResult.state === 'failing') {
      const ciSession = options.sessions?.get('verify', {
        model: verifyModel,
        permissionMode: 'plan',
      });
      const ciChecks = ciResult.checks ?? [];
      const ciPlan = await runStep(ctx, 'ci.fix.plan', 'Plan CI fixes', () =>
        generateCiFixPlan({
          model: verifyModel,
          ci: {
            state: ciResult.state,
            ...(ciResult.summary ? { summary: ciResult.summary } : {}),
            checks: ciChecks.map((check) => ({
              name: check.name,
              ...(check.conclusion ? { conclusion: check.conclusion } : {}),
              ...(check.url ? { url: check.url } : {}),
            })),
          },
          ...verifyBudgets,
          ...(ciSession ? { session: ciSession } : {}),
          ...(ctx.events.bus ? { bus: ctx.events.bus } : {}),
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
        }),
      );

      await updateState(ctx, (data) => ({ ...data, ciFixPlan: ciPlan }));

      const ciPlanDigest = hashString(JSON.stringify(ciPlan));
      await runStep(ctx, 'ci.fix.apply', 'Apply CI fixes', () =>
        executePlan({
          model: execModel,
          repoRoot: ctx.repo.repoRoot,
          config: ctx.config,
          dryRun: Boolean(options.dryRun),
          allowDestructive: Boolean(options.apply),
          allowDangerous: Boolean(options.dangerous),
          planDigest: ciPlanDigest,
          ...execBudgets,
          ...(options.sessions ? { sessionPool: options.sessions } : {}),
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
          state: ctx.state,
          heartbeat: () => heartbeatStep(ctx, 'ci.fix.apply'),
        }),
      );

      const ciVerify = await runStep(ctx, 'ci.fix.verify', 'Verify CI fixes', () =>
        runVerifyCommands(ctx.config, { cwd: ctx.repo.repoRoot }),
      );
      if (!ciVerify.ok) {
        throw new Error('Verification failed during CI fix');
      }

      await runStep(ctx, 'ci.fix.checkpoint', 'Checkpoint CI fixes', () =>
        createCheckpointCommit(ctx, `silvan: checkpoint ci-${iteration + 1}`),
      );

      await runStep(ctx, 'ci.fix.push', 'Push CI fixes', () =>
        runGit(['push', 'origin', headBranch], {
          cwd: ctx.repo.repoRoot,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
        }),
      );

      const ciAfter = await runStep(ctx, 'ci.wait.review', 'Wait for CI', () =>
        waitForCi({
          owner,
          repo,
          headBranch,
          pollIntervalMs: 15000,
          timeoutMs: 900000,
          onHeartbeat: () => heartbeatStep(ctx, 'ci.wait.review'),
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
        }),
      );
      if (ciAfter.state === 'failing') {
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
        ...(typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}),
        unresolvedReviewCount: review.comments.length,
      },
    }));

    if (review.comments.length === 0 && ciResult.state === 'passing') {
      await changePhase(ctx, 'complete', 'review_loop_clean');
      const latest = await ctx.state.readRunState(ctx.runId);
      const latestData = getRunState((latest?.data as Record<string, unknown>) ?? {});
      const ticket = latestData['ticket'] as LinearTicket | undefined;
      const linearStates = ctx.config.linear.states;
      const doneState = linearStates?.done;
      if (ctx.config.linear.enabled && ticket?.identifier && doneState) {
        await runStep(ctx, 'linear.ticket.move_done', 'Move ticket to Done', () =>
          moveLinearTicket(ticket.identifier, doneState),
        );
      }
      break;
    }

    type ReviewThreadInput = {
      threadId: string;
      comments: Array<{
        id: string;
        path?: string | null;
        line?: number | null;
        bodyDigest: string;
        excerpt?: string;
      }>;
      isOutdated: boolean;
    };

    const threads = review.comments.reduce<Record<string, ReviewThreadInput>>(
      (acc, comment) => {
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
          excerpt: comment.body.slice(0, 200),
        });
        return acc;
      },
      {},
    );

    await updateState(ctx, (data) => ({
      ...data,
      reviewThreads: Object.values(threads),
    }));

    const reviewSession = options.sessions?.get('review', {
      model: reviewModel,
      permissionMode: 'plan',
    });

    const reviewRegistry = createToolRegistry({
      repoRoot: ctx.repo.repoRoot,
      config: ctx.config,
      dryRun: true,
      allowDestructive: false,
      allowDangerous: false,
      emitContext: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      ...(ctx.events.bus ? { bus: ctx.events.bus } : {}),
      state: ctx.state,
    });
    const fixPlan = await runStep(ctx, 'review.plan', 'Plan review fixes', () =>
      generateReviewFixPlan({
        model: reviewModel,
        threads: Object.values(threads),
        ...reviewBudgets,
        ...(reviewSession ? { session: reviewSession } : {}),
        mcpServers: { 'silvan-tools': reviewRegistry.sdkServer },
        allowedTools: reviewRegistry.toolNames,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );

    await updateState(ctx, (data) => ({
      ...data,
      reviewFixPlan: fixPlan,
      reviewIteration: iteration + 1,
    }));

    const reviewPlan: Plan = {
      summary: 'Review fixes',
      steps: fixPlan.threads.map((thread) => ({
        id: thread.threadId,
        title: thread.summary,
        description: thread.summary,
      })),
      verification: fixPlan.verification ?? [],
    };

    const reviewPlanDigest = hashString(JSON.stringify(reviewPlan));
    await runStep(ctx, 'review.apply', 'Apply review fixes', () =>
      executePlan({
        model: execModel,
        repoRoot: ctx.repo.repoRoot,
        config: ctx.config,
        dryRun: Boolean(options.dryRun),
        allowDestructive: Boolean(options.apply),
        allowDangerous: Boolean(options.dangerous),
        planDigest: reviewPlanDigest,
        ...execBudgets,
        ...(options.sessions ? { sessionPool: options.sessions } : {}),
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
        state: ctx.state,
        heartbeat: () => heartbeatStep(ctx, 'review.apply'),
      }),
    );

    const verifyReport = await runStep(ctx, 'review.verify', 'Verify review fixes', () =>
      runVerifyCommands(ctx.config, { cwd: ctx.repo.repoRoot }),
    );
    await updateState(ctx, (data) => ({
      ...data,
      reviewVerifyReport: verifyReport,
    }));
    if (!verifyReport.ok) {
      throw new Error('Verification failed during review loop');
    }

    await runStep(
      ctx,
      'review.checkpoint',
      'Checkpoint review fixes',
      () =>
        createCheckpointCommit(
          ctx,
          `silvan: checkpoint review-${iteration + 1}`,
        ),
      {
        inputs: { iteration: iteration + 1 },
        artifacts: (result) => ({ checkpoint: result }),
      },
    );

    await runStep(ctx, 'review.push', 'Push review fixes', () =>
      runGit(['push', 'origin', headBranch], {
        cwd: ctx.repo.repoRoot,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
      }),
    );

    const ciAfter = await runStep(ctx, 'ci.wait', 'Wait for CI', () =>
      waitForCi({
        owner,
        repo,
        headBranch,
        pollIntervalMs: 15000,
        timeoutMs: 900000,
        onHeartbeat: () => heartbeatStep(ctx, 'ci.wait'),
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );
    await updateState(ctx, (data) => ({
      ...data,
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}),
        ci: ciAfter.state,
      },
    }));
    if (ciAfter.state === 'failing') {
      throw new Error('CI failed during review loop');
    }

    if (fixPlan.resolveThreads?.length) {
      for (const threadId of fixPlan.resolveThreads) {
        await runStep(ctx, 'review.resolve', 'Resolve review thread', () =>
          resolveReviewThread({
            threadId,
            pr: review.pr,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
        );
      }
    }

    await runStep(ctx, 'github.review.request', 'Re-request reviewers', () =>
      requestReviewers({
        pr: review.pr,
        reviewers: ctx.config.github.reviewers,
        requestCopilot: ctx.config.github.requestCopilot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );
  }
}

export async function runRecovery(
  ctx: RunContext,
  options: { sessions?: SessionPool } = {},
): Promise<void> {
  const state = await ctx.state.readRunState(ctx.runId);
  const data = (state?.data as Record<string, unknown>) ?? {};
  const model = getModelForPhase('recovery');
  const recoveryBudgets = getBudgetsForPhase('recovery');
  const recoverySession = options.sessions?.get('recovery', {
    model,
    permissionMode: 'plan',
  });
  const plan = await runStep(ctx, 'agent.recovery.plan', 'Plan recovery', () =>
    generateRecoveryPlan({
      model,
      runState: data,
      ...recoveryBudgets,
      ...(recoverySession ? { session: recoverySession } : {}),
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    }),
  );
  await updateState(ctx, (prev) => ({ ...prev, recovery: plan }));

  switch (plan.nextAction) {
    case 'rerun_verification': {
      await changePhase(ctx, 'verify', 'recovery');
      const verifyReport = await runStep(
        ctx,
        'recovery.verify',
        'Rerun verification',
        () => runVerifyCommands(ctx.config, { cwd: ctx.repo.repoRoot }),
      );
      await updateState(ctx, (prev) => ({
        ...prev,
        recoveryResult: { action: plan.nextAction, verifyReport },
      }));
      if (!verifyReport.ok) {
        throw new Error('Verification failed during recovery');
      }
      return;
    }
    case 'refetch_reviews': {
      await changePhase(ctx, 'review', 'recovery');
      requireGitHubAuth();
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
    const ticket = data['ticket'];
    const ticketId =
      typeof ticket === 'object' && ticket && 'identifier' in ticket
        ? (ticket as { identifier?: string }).identifier
        : undefined;
    await runPlanner(ctx, {
      ...(ticketId ? { ticketId } : {}),
      ...(options.sessions ? { sessions: options.sessions } : {}),
    });
    return;
  }

  if (run?.phase === 'implement' || run?.phase === 'verify' || run?.phase === 'pr') {
    await runImplementation(ctx, options);
    return;
  }

  if (run?.phase === 'review') {
    await runReviewLoop(ctx, options);
    return;
  }

  if (run?.phase === 'complete') {
    return;
  }

  await runRecovery(ctx, {
    ...(options.sessions ? { sessions: options.sessions } : {}),
  });
}
