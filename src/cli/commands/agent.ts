import type { CAC } from 'cac';

import { collectClarifications } from '../../agent/clarify';
import type { Plan } from '../../agent/schemas';
import type { RunContext } from '../../core/context';
import {
  runImplementation,
  runLearningNotes,
  runPlanner,
  runRecovery,
  runReviewLoop,
} from '../../core/run-controller';
import type { EventMode } from '../../events/schema';
import { parseAnswerPairs } from '../answers';
import { emitJsonSuccess } from '../json-output';
import { createCliLogger } from '../logger';
import { renderSuccessSummary } from '../output';
import {
  renderNextSteps,
  renderPlanSummary,
  renderReadySection,
  summarizePlan,
} from '../task-start-output';
import type { CliOptions } from '../types';

export type AgentCommandDeps = {
  withCliContext: <T>(
    options: CliOptions | undefined,
    mode: EventMode,
    fn: (ctx: RunContext) => Promise<T>,
  ) => Promise<T>;
  withAgentSessions: <T>(
    enabled: boolean,
    fn: (
      sessions: ReturnType<typeof import('../../agent/session').createSessionPool>,
    ) => Promise<T>,
  ) => Promise<T>;
  persistRunState: (
    ctx: RunContext,
    mode: EventMode,
    update: (data: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<void>;
};

export function registerAgentCommands(cli: CAC, deps: AgentCommandDeps): void {
  cli
    .command('agent plan', 'Generate plan')
    .option('--task <task>', 'Task reference (Linear ID, gh-<number>, or URL)')
    .action((options: CliOptions) =>
      deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) => {
        const plan = await deps.withAgentSessions(
          Boolean(ctx.config.ai.sessions.persist),
          (sessions) =>
            runPlanner(ctx, {
              ...(options.task ? { taskRef: options.task } : {}),
              sessions,
            }),
        );
        const planSummary = summarizePlan(plan);
        const nextSteps = buildPlanNextSteps(plan);

        if (options.json) {
          await emitJsonSuccess({
            command: 'agent plan',
            data: {
              runId: ctx.runId,
              planSummary,
              questionCount: plan.questions?.length ?? 0,
              requiredQuestionCount: countRequiredQuestions(plan),
            },
            nextSteps,
            repoRoot: ctx.repo.repoRoot,
            runId: ctx.runId,
          });
          return;
        }

        if (options.quiet) {
          return;
        }

        const logger = createCliLogger(ctx);
        await logger.info(renderPlanSummary(planSummary));
        await logger.info(
          renderReadySection({
            title: 'Plan generated',
            runId: ctx.runId,
          }),
        );
        await logger.info(renderNextSteps(nextSteps));
      }),
    );

  cli
    .command('agent clarify', 'Answer plan questions')
    .option('--answer <pair>', 'Answer question (id=value)', { default: [] })
    .action((options: CliOptions & { answer?: string | string[] }) =>
      deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) =>
        deps.withAgentSessions(
          Boolean(ctx.config.ai.sessions.persist),
          async (sessions) => {
            const logger = createCliLogger(ctx);
            const state = await ctx.state.readRunState(ctx.runId);
            const data = (state?.data as Record<string, unknown>) ?? {};
            const plan = data['plan'];
            if (!plan || typeof plan !== 'object') {
              throw new Error('No plan found in run state. Run agent plan first.');
            }

            const questions = Array.isArray((plan as { questions?: unknown }).questions)
              ? ((
                  plan as {
                    questions?: Array<{ id: string; text: string; required?: boolean }>;
                  }
                ).questions ?? [])
              : [];

            if (questions.length === 0) {
              const nextSteps = ['silvan agent run --apply'];

              if (options.json) {
                await emitJsonSuccess({
                  command: 'agent clarify',
                  data: {
                    runId: ctx.runId,
                    questionCount: 0,
                  },
                  nextSteps,
                  repoRoot: ctx.repo.repoRoot,
                  runId: ctx.runId,
                });
                return;
              }

              if (!options.quiet) {
                await logger.info(
                  renderSuccessSummary({
                    title: 'No clarifications needed',
                    details: [['Run ID', ctx.runId]],
                    nextSteps,
                  }),
                );
              }
              return;
            }

            const provided = parseAnswerPairs(options.answer);
            const clarifications = await collectClarifications({
              questions,
              answers: {
                ...(typeof data['clarifications'] === 'object' && data['clarifications']
                  ? (data['clarifications'] as Record<string, string>)
                  : {}),
                ...provided,
              },
            });

            const missingRequired = questions.filter(
              (question) => question.required !== false && !clarifications[question.id],
            );
            if (missingRequired.length > 0) {
              const ids = missingRequired.map((question) => question.id).join(', ');
              throw new Error(`Missing required clarifications: ${ids}`);
            }

            await deps.persistRunState(ctx, ctx.events.mode, (data) => ({
              ...data,
              clarifications,
            }));

            const task = data['task'];
            const taskRef =
              typeof data['taskRef'] === 'object' && data['taskRef']
                ? (data['taskRef'] as { raw?: string }).raw
                : undefined;
            const taskId =
              typeof task === 'object' && task && 'id' in task
                ? (task as { id?: string }).id
                : undefined;

            const updatedPlan = await runPlanner(ctx, {
              ...(taskRef ? { taskRef } : taskId ? { taskRef: taskId } : {}),
              clarifications,
              sessions,
            });

            const planSummary = summarizePlan(updatedPlan);
            const nextSteps = buildPlanNextSteps(updatedPlan, { includeClarify: false });

            if (options.json) {
              await emitJsonSuccess({
                command: 'agent clarify',
                data: {
                  runId: ctx.runId,
                  planSummary,
                  questionCount: updatedPlan.questions?.length ?? 0,
                  requiredQuestionCount: countRequiredQuestions(updatedPlan),
                },
                nextSteps,
                repoRoot: ctx.repo.repoRoot,
                runId: ctx.runId,
              });
              return;
            }

            if (options.quiet) {
              return;
            }

            await logger.info(renderPlanSummary(planSummary, { title: 'Updated Plan' }));
            await logger.info(
              renderReadySection({
                title: 'Plan updated',
                runId: ctx.runId,
              }),
            );
            await logger.info(renderNextSteps(nextSteps));
          },
        ),
      ),
    );

  cli
    .command('agent run', 'Execute the implementation plan')
    .option('--dry-run', 'Read-only mode: no file changes (default)')
    .option('--apply', 'Allow file modifications (edits, writes, deletes)')
    .option('--dangerous', 'Allow shell commands and network access (requires --apply)')
    .action((options: CliOptions) =>
      deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) =>
        deps.withAgentSessions(
          Boolean(ctx.config.ai.sessions.persist),
          async (sessions) => {
            const runOptions = {
              ...(options.dryRun ? { dryRun: true } : {}),
              ...(options.apply ? { apply: true } : {}),
              ...(options.dangerous ? { dangerous: true } : {}),
              sessions,
            };
            const shouldReview = await runImplementation(ctx, runOptions);
            if (shouldReview) {
              await runReviewLoop(ctx, runOptions);
            }
            await runLearningNotes(ctx, { allowApply: Boolean(options.apply) });

            const summary = await loadRunSummary(ctx);
            const details = buildAgentRunDetails(ctx.runId, summary, options);
            const nextSteps = buildAgentRunNextSteps(ctx.runId, summary, options);

            if (options.json) {
              await emitJsonSuccess({
                command: 'agent run',
                data: {
                  runId: ctx.runId,
                  summary,
                  mode: options.apply ? 'apply' : 'dry-run',
                },
                nextSteps,
                repoRoot: ctx.repo.repoRoot,
                runId: ctx.runId,
              });
              return;
            }

            if (options.quiet) {
              return;
            }

            const logger = createCliLogger(ctx);
            await logger.info(
              renderSuccessSummary({
                title: options.apply ? 'Run completed' : 'Dry-run completed',
                details,
                nextSteps,
              }),
            );
          },
        ),
      ),
    );

  cli.command('agent resume', 'Resume agent').action((options: CliOptions) =>
    deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) =>
      deps.withAgentSessions(Boolean(ctx.config.ai.sessions.persist), async () => {
        await runRecovery(ctx);

        const summary = await loadRunSummary(ctx);
        const details = buildAgentRunDetails(ctx.runId, summary, options, {
          includeMode: false,
        });
        const nextSteps = buildAgentResumeNextSteps(ctx.runId, summary);

        if (options.json) {
          await emitJsonSuccess({
            command: 'agent resume',
            data: {
              runId: ctx.runId,
              summary,
            },
            nextSteps,
            repoRoot: ctx.repo.repoRoot,
            runId: ctx.runId,
          });
          return;
        }

        if (options.quiet) {
          return;
        }

        const logger = createCliLogger(ctx);
        await logger.info(
          renderSuccessSummary({
            title: 'Recovery complete',
            details,
            nextSteps,
          }),
        );
      }),
    ),
  );
}

function countRequiredQuestions(plan: Plan): number {
  return plan.questions?.filter((question) => question.required !== false).length ?? 0;
}

function buildPlanNextSteps(
  plan: Plan,
  options?: { includeClarify?: boolean },
): string[] {
  const includeClarify = options?.includeClarify !== false;
  const steps: string[] = [];
  if (includeClarify && (plan.questions?.length ?? 0) > 0) {
    steps.push('silvan agent clarify');
  }
  steps.push('silvan agent run --apply');
  return steps;
}

async function loadRunSummary(ctx: RunContext): Promise<{
  prUrl?: string;
  ci?: string;
  unresolvedReviewCount?: number;
}> {
  const state = await ctx.state.readRunState(ctx.runId);
  const data = (state?.data as Record<string, unknown>) ?? {};
  const summary = (
    typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}
  ) as { prUrl?: string; ci?: string; unresolvedReviewCount?: number };
  return {
    ...(typeof summary.prUrl === 'string' ? { prUrl: summary.prUrl } : {}),
    ...(typeof summary.ci === 'string' ? { ci: summary.ci } : {}),
    ...(typeof summary.unresolvedReviewCount === 'number'
      ? { unresolvedReviewCount: summary.unresolvedReviewCount }
      : {}),
  };
}

function buildAgentRunDetails(
  runId: string,
  summary: { prUrl?: string; ci?: string; unresolvedReviewCount?: number },
  options: CliOptions,
  overrides?: { includeMode?: boolean },
): Array<[string, string]> {
  const details: Array<[string, string]> = [['Run ID', runId]];
  const includeMode = overrides?.includeMode !== false;
  if (includeMode) {
    details.push(['Mode', options.apply ? 'apply' : 'dry-run']);
  }
  if (summary.prUrl) {
    details.push(['PR', summary.prUrl]);
  }
  if (summary.ci) {
    details.push(['CI', summary.ci]);
  }
  if (summary.unresolvedReviewCount !== undefined) {
    details.push(['Unresolved reviews', `${summary.unresolvedReviewCount}`]);
  }
  return details;
}

function buildAgentRunNextSteps(
  runId: string,
  summary: { prUrl?: string; ci?: string; unresolvedReviewCount?: number },
  options: CliOptions,
): string[] {
  const steps: string[] = [];
  if (!options.apply) {
    steps.push('silvan agent run --apply');
  } else if (!summary.prUrl) {
    steps.push('silvan pr open');
  }
  steps.push(`silvan run status ${runId}`);
  steps.push(`silvan run explain ${runId}`);
  return steps;
}

function buildAgentResumeNextSteps(
  runId: string,
  summary: { prUrl?: string; ci?: string; unresolvedReviewCount?: number },
): string[] {
  const steps: string[] = [];
  if (!summary.prUrl) {
    steps.push('silvan pr open');
  }
  steps.push(`silvan run status ${runId}`);
  steps.push(`silvan run explain ${runId}`);
  return steps;
}
