import { toEventError } from '../events/emit';
import type { RunContext } from './context';
import { runImplementation } from './run-execute';
import {
  getRunState,
  isLeaseStale,
  type RunControllerOptions,
  type StepRecord,
  updateState,
} from './run-helpers';
import { runLearningNotes } from './run-learning';
import { runPlanner } from './run-plan';
import { runRecovery } from './run-recovery';
import { runReviewLoop } from './run-review';

export { runImplementation, runLearningNotes, runPlanner, runRecovery, runReviewLoop };

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
