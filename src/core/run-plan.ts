import { generateExecutionKickoffPrompt } from '../ai/cognition/kickoff';
import { generatePlan } from '../ai/cognition/planner';
import { createConversationStore } from '../ai/conversation';
import { hashPrompt, renderPromptSummary } from '../prompts';
import { resolveTask } from '../task/resolve';
import { hashString } from '../utils/hash';
import type { RunContext } from './context';
import { SilvanError } from './errors';
import {
  changePhase,
  type RunControllerOptions,
  runStep,
  updateState,
} from './run-helpers';

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
