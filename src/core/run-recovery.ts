import { generateRecoveryPlan } from '../ai/cognition/recovery';
import { createConversationStore } from '../ai/conversation';
import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import { fetchUnresolvedReviewComments } from '../github/review';
import { runVerifyCommands } from '../verify/run';
import type { RunContext } from './context';
import {
  changePhase,
  recordVerificationAssist,
  runStep,
  updateState,
} from './run-helpers';
import { runReviewLoop } from './run-review';

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
