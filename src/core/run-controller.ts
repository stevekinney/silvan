import { executePlan } from '../agent/executor';
import { generatePlan } from '../agent/planner';
import { draftPullRequest } from '../agent/pr-writer';
import { generateRecoveryPlan } from '../agent/recovery';
import { generateReviewFixPlan } from '../agent/reviewer';
import { type Plan, planSchema } from '../agent/schemas';
import { decideVerification } from '../agent/verifier';
import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import { createEnvelope } from '../events/emit';
import type { Phase, RunPhaseChanged } from '../events/schema';
import { runGit } from '../git/exec';
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
  await ctx.events.bus.emit(
    createEnvelope({
      type: 'run.phase_changed',
      source: 'engine',
      level: 'info',
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      payload: {
        from: 'idle',
        to,
        ...(reason ? { reason } : {}),
      } satisfies RunPhaseChanged,
    }),
  );
}

export async function runPlanner(ctx: RunContext, options: RunControllerOptions) {
  await changePhase(ctx, 'plan');
  const model = getModel();

  const plan = await generatePlan({
    ...(options.ticketId ? { ticketId: options.ticketId } : {}),
    ...(options.worktreeName ? { worktreeName: options.worktreeName } : {}),
    repoRoot: ctx.repo.repoRoot,
    model,
    bus: ctx.events.bus,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
  });

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
  const summary = await executePlan({
    plan,
    model,
    repoRoot: ctx.repo.repoRoot,
    config: ctx.config,
    dryRun: Boolean(options.dryRun),
    allowDestructive: Boolean(options.apply),
    bus: ctx.events.bus,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    maxTurns: Number(Bun.env['SILVAN_MAX_TURNS'] ?? 12),
    ...(Bun.env['SILVAN_MAX_BUDGET_USD']
      ? { maxBudgetUsd: Number(Bun.env['SILVAN_MAX_BUDGET_USD']) }
      : {}),
    ...(Bun.env['SILVAN_MAX_THINKING_TOKENS']
      ? { maxThinkingTokens: Number(Bun.env['SILVAN_MAX_THINKING_TOKENS']) }
      : {}),
    toolCallLog,
  });

  await updateState(ctx, (data) => ({
    ...data,
    implementationSummary: summary,
    toolCalls: toolCallLog,
  }));

  await changePhase(ctx, 'verify');
  const verifyReport = await runVerifyCommands(ctx.config, { cwd: ctx.repo.repoRoot });
  await updateState(ctx, (data) => ({ ...data, verifyReport }));

  if (!verifyReport.ok) {
    await decideVerification({
      model,
      report: {
        ok: verifyReport.ok,
        results: verifyReport.results.map((result) => ({
          name: result.name,
          exitCode: result.exitCode,
          stderr: result.stderr,
        })),
      },
      ...(ctx.events.bus ? { bus: ctx.events.bus } : {}),
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    });
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
  const prDraft = await draftPullRequest({
    model,
    planSummary,
    changesSummary: summary,
    ...(ticketUrl ? { ticketUrl } : {}),
  });

  const github = await requireGitHubConfig({
    config: ctx.config,
    repoRoot: ctx.repo.repoRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    bus: ctx.events.bus,
  });
  const { owner, repo } = github;
  const headBranch = ctx.repo.branch;
  const baseBranch = ctx.config.github.baseBranch ?? ctx.config.repo.defaultBranch;
  const prResult = await openOrUpdatePr({
    owner,
    repo,
    headBranch,
    baseBranch,
    title: prDraft.title,
    body: prDraft.body,
    bus: ctx.events.bus,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
  });
  await requestReviewers({
    pr: prResult.pr,
    reviewers: ctx.config.github.reviewers,
    requestCopilot: ctx.config.github.requestCopilot,
    bus: ctx.events.bus,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
  });

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
    const review = await fetchUnresolvedReviewComments({
      owner,
      repo,
      headBranch,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    });
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

    const fixPlan = await generateReviewFixPlan({
      model,
      threads: Object.values(threads),
    });

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

    await executePlan({
      plan: reviewPlan,
      model,
      repoRoot: ctx.repo.repoRoot,
      config: ctx.config,
      dryRun: Boolean(options.dryRun),
      allowDestructive: Boolean(options.apply),
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    });

    const verifyReport = await runVerifyCommands(ctx.config, { cwd: ctx.repo.repoRoot });
    await updateState(ctx, (data) => ({
      ...data,
      reviewVerifyReport: verifyReport,
    }));
    if (!verifyReport.ok) {
      throw new Error('Verification failed during review loop');
    }

    await runGit(['push', 'origin', headBranch], {
      cwd: ctx.repo.repoRoot,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
    });

    if (fixPlan.resolveThreads?.length) {
      for (const threadId of fixPlan.resolveThreads) {
        await resolveReviewThread({
          threadId,
          pr: review.pr,
          bus: ctx.events.bus,
          context: {
            runId: ctx.runId,
            repoRoot: ctx.repo.repoRoot,
            mode: ctx.events.mode,
          },
        });
      }
    }
  }
}

export async function runRecovery(ctx: RunContext): Promise<void> {
  const state = await ctx.state.readRunState(ctx.runId);
  const data = (state?.data as Record<string, unknown>) ?? {};
  const plan = await generateRecoveryPlan({ model: getModel(), runState: data });
  await updateState(ctx, (prev) => ({ ...prev, recovery: plan }));
}
