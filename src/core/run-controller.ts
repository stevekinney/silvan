import { executePlan } from '../agent/executor';
import { generatePlan } from '../agent/planner';
import { draftPullRequest } from '../agent/pr-writer';
import { generateRecoveryPlan } from '../agent/recovery';
import { generateReviewFixPlan } from '../agent/reviewer';
import { type Plan, planSchema } from '../agent/schemas';
import type { SessionPool } from '../agent/session';
import { decideVerification } from '../agent/verifier';
import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import { createEnvelope } from '../events/emit';
import type { Phase, RunPhaseChanged, RunStep } from '../events/schema';
import { runGit } from '../git/exec';
import { waitForCi } from '../github/ci';
import { openOrUpdatePr, requestReviewers } from '../github/pr';
import { fetchUnresolvedReviewComments, resolveReviewThread } from '../github/review';
import { fetchLinearTicket, type LinearTicket } from '../linear/linear';
import { hashString } from '../utils/hash';
import { runVerifyCommands } from '../verify/run';
import type { RunContext } from './context';

type RunControllerOptions = {
  ticketId?: string;
  worktreeName?: string;
  dryRun?: boolean;
  apply?: boolean;
  dangerous?: boolean;
  sessions?: SessionPool;
};

function getModel(): string {
  return Bun.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-5-20250929';
}

async function updateState(
  ctx: RunContext,
  updater: (data: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const snapshotId = await ctx.state.updateRunState(ctx.runId, updater);
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
  const from = typeof data['phase'] === 'string' ? (data['phase'] as Phase) : 'idle';

  await updateState(ctx, (prev) => ({ ...prev, phase: to }));

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
): Promise<T> {
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

export async function runPlanner(ctx: RunContext, options: RunControllerOptions) {
  await changePhase(ctx, 'plan');
  const model = getModel();
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
    summary: {
      ...(typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}),
      planDigest: hashString(JSON.stringify(plan)),
    },
  }));

  if (plan.questions?.length) {
    throw new Error('Clarifications required before execution.');
  }

  return plan;
}

export async function runImplementation(ctx: RunContext, options: RunControllerOptions) {
  const state = await ctx.state.readRunState(ctx.runId);
  const data = (state?.data as Record<string, unknown>) ?? {};
  const planResult = planSchema.safeParse(data['plan']);
  if (!planResult.success) {
    throw new Error('No plan found in run state. Run agent plan first.');
  }
  const plan = planResult.data;

  await changePhase(ctx, 'implement');
  const model = getModel();
  const toolCallLog: Array<{
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    resultDigest?: string;
    ok: boolean;
  }> = [];
  const summary = await runStep(ctx, 'agent.execute', 'Execute plan', () =>
    executePlan({
      plan,
      model,
      repoRoot: ctx.repo.repoRoot,
      config: ctx.config,
      dryRun: Boolean(options.dryRun),
      allowDestructive: Boolean(options.apply),
      allowDangerous: Boolean(options.dangerous),
      ...(options.sessions ? { sessionPool: options.sessions } : {}),
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      maxTurns: Number(Bun.env['SILVAN_MAX_TURNS'] ?? 12),
      ...(Bun.env['SILVAN_MAX_BUDGET_USD']
        ? { maxBudgetUsd: Number(Bun.env['SILVAN_MAX_BUDGET_USD']) }
        : {}),
      ...(Bun.env['SILVAN_MAX_THINKING_TOKENS']
        ? { maxThinkingTokens: Number(Bun.env['SILVAN_MAX_THINKING_TOKENS']) }
        : {}),
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
      toolCallLog,
    }),
  );

  await updateState(ctx, (data) => ({
    ...data,
    implementationSummary: summary,
    toolCalls: toolCallLog,
  }));

  await changePhase(ctx, 'verify');
  const verifyReport = await runStep(ctx, 'verify.run', 'Run verification', () =>
    runVerifyCommands(ctx.config, { cwd: ctx.repo.repoRoot }),
  );
  await updateState(ctx, (data) => ({ ...data, verifyReport }));

  if (!verifyReport.ok) {
    const verifySession = options.sessions?.get('verify', {
      model,
      permissionMode: 'plan',
    });
    const decision = await decideVerification({
      model,
      report: {
        ok: verifyReport.ok,
        results: verifyReport.results.map((result) => ({
          name: result.name,
          exitCode: result.exitCode,
          stderr: result.stderr,
        })),
      },
      ...(verifySession ? { session: verifySession } : {}),
      ...(ctx.events.bus ? { bus: ctx.events.bus } : {}),
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    });
    await updateState(ctx, (data) => ({ ...data, verificationDecision: decision }));
    throw new Error('Verification failed');
  }

  await changePhase(ctx, 'pr');
  requireGitHubAuth();
  const planSummary = plan.summary ?? 'Plan';
  const ticketUrl = (() => {
    const ticket = data['ticket'];
    if (typeof ticket !== 'object' || ticket === null) return undefined;
    const url = (ticket as LinearTicket).url;
    return typeof url === 'string' ? url : undefined;
  })();
  const prSession = options.sessions?.get('pr', {
    model,
    permissionMode: 'plan',
  });
  const prDraft = await runStep(ctx, 'pr.draft', 'Draft PR description', () =>
    draftPullRequest({
      model,
      planSummary,
      changesSummary: summary,
      ...(ticketUrl ? { ticketUrl } : {}),
      ...(prSession ? { session: prSession } : {}),
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    }),
  );

  const github = await requireGitHubConfig({
    config: ctx.config,
    repoRoot: ctx.repo.repoRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    bus: ctx.events.bus,
  });
  const { owner, repo } = github;
  const headBranch = ctx.repo.branch;
  const baseBranch = ctx.config.github.baseBranch ?? ctx.config.repo.defaultBranch;
  const prResult = await runStep(ctx, 'github.pr.open', 'Open or update PR', () =>
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
  await runStep(ctx, 'github.review.request', 'Request reviewers', () =>
    requestReviewers({
      pr: prResult.pr,
      reviewers: ctx.config.github.reviewers,
      requestCopilot: ctx.config.github.requestCopilot,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    }),
  );

  await updateState(ctx, (data) => ({ ...data, prDraft, pr: prResult.pr }));
  return prResult.pr;
}

export async function runReviewLoop(ctx: RunContext, options: RunControllerOptions) {
  await changePhase(ctx, 'review');
  requireGitHubAuth();
  const model = getModel();
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
    if (review.comments.length === 0) break;

    type ReviewThreadInput = {
      threadId: string;
      comments: Array<{
        id: string;
        body: string;
        path?: string | null;
        line?: number | null;
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
          body: comment.body,
          path: comment.path,
          line: comment.line,
        });
        return acc;
      },
      {},
    );

    const reviewSession = options.sessions?.get('review', {
      model,
      permissionMode: 'plan',
    });
    const fixPlan = await runStep(ctx, 'review.plan', 'Plan review fixes', () =>
      generateReviewFixPlan({
        model,
        threads: Object.values(threads),
        ...(reviewSession ? { session: reviewSession } : {}),
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

    await runStep(ctx, 'review.apply', 'Apply review fixes', () =>
      executePlan({
        plan: reviewPlan,
        model,
        repoRoot: ctx.repo.repoRoot,
        config: ctx.config,
        dryRun: Boolean(options.dryRun),
        allowDestructive: Boolean(options.apply),
        allowDangerous: Boolean(options.dangerous),
        ...(options.sessions ? { sessionPool: options.sessions } : {}),
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
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

    await runStep(ctx, 'review.push', 'Push review fixes', () =>
      runGit(['push', 'origin', headBranch], {
        cwd: ctx.repo.repoRoot,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
      }),
    );

    const ciResult = await runStep(ctx, 'ci.wait', 'Wait for CI', () =>
      waitForCi({
        owner,
        repo,
        headBranch,
        pollIntervalMs: 15000,
        timeoutMs: 900000,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );
    if (ciResult.state === 'failing') {
      throw new Error('CI failed during review loop');
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
  }
}

export async function runRecovery(
  ctx: RunContext,
  options: { sessions?: SessionPool } = {},
): Promise<void> {
  const state = await ctx.state.readRunState(ctx.runId);
  const data = (state?.data as Record<string, unknown>) ?? {};
  const model = getModel();
  const recoverySession = options.sessions?.get('recovery', {
    model,
    permissionMode: 'plan',
  });
  const plan = await runStep(ctx, 'agent.recovery.plan', 'Plan recovery', () =>
    generateRecoveryPlan({
      model,
      runState: data,
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
