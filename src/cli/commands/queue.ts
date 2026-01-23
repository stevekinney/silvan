import type { CAC } from 'cac';

import type { SessionPool } from '../../agent/session';
import type { ConfigInput } from '../../config/schema';
import type { RunContext } from '../../core/context';
import { withRunContext } from '../../core/context';
import { SilvanError } from '../../core/errors';
import type { EventMode } from '../../events/schema';
import {
  applyQueuePriority,
  PRIORITY_MAX,
  PRIORITY_MIN,
  sortByPriority,
} from '../../queue/priority';
import { runPriorityQueueRequests, runQueueRequests } from '../../queue/runner';
import {
  deleteQueueRequest,
  listQueueRequests,
  setQueueRequestPriority,
} from '../../state/queue';
import type { LocalTaskInput } from '../../task/providers/local';
import { emitJsonResult, emitJsonSuccess } from '../json-output';
import {
  formatKeyList,
  formatKeyValues,
  renderSectionHeader,
  renderSuccessSummary,
} from '../output';
import { renderNextSteps } from '../task-start-output';

export type QueueOptions = {
  json?: boolean;
  quiet?: boolean;
  concurrency?: string;
  continueOnError?: boolean;
};

type CliLogger = { info: (message: string) => Promise<void> | void };

type QueueCommandDeps = {
  withCliContext: <T>(
    options: QueueOptions,
    mode: EventMode,
    fn: (ctx: RunContext) => Promise<T>,
  ) => Promise<T>;
  createCliLogger: (ctx: RunContext) => CliLogger;
  buildConfigOverrides: (options: QueueOptions) => ConfigInput;
  parseConcurrency: (value: string | undefined, fallback?: number) => number;
  parseQueuePriority: (value: string | undefined, fallback: number) => number;
  withAgentSessions: <T>(
    persist: boolean,
    fn: (sessions: SessionPool | undefined) => Promise<T>,
  ) => Promise<T>;
  startTaskFlow: (options: {
    ctx: RunContext;
    sessions?: SessionPool;
    taskRef: string;
    localInput: LocalTaskInput;
    printCd: boolean;
  }) => Promise<void>;
};

export function registerQueueCommands(cli: CAC, deps: QueueCommandDeps): void {
  cli
    .command('queue status', 'Show queued task depth by priority level')
    .action((options: QueueOptions) =>
      deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) => {
        const jsonMode = Boolean(options.json);
        const logger = deps.createCliLogger(ctx);
        const requests = await listQueueRequests({ state: ctx.state });
        const prioritizedRequests = requests
          .map((request) => applyQueuePriority(request, ctx.config))
          .sort(sortByPriority);
        const priorityDepth = new Map<number, number>();
        const basePriorityDepth = new Map<number, number>();
        for (let priority = PRIORITY_MIN; priority <= PRIORITY_MAX; priority += 1) {
          priorityDepth.set(priority, 0);
          basePriorityDepth.set(priority, 0);
        }
        const tierDepth = {
          high: 0,
          medium: 0,
          low: 0,
        };
        let boosted = 0;
        for (const request of prioritizedRequests) {
          priorityDepth.set(
            request.effectivePriority,
            (priorityDepth.get(request.effectivePriority) ?? 0) + 1,
          );
          basePriorityDepth.set(
            request.priority,
            (basePriorityDepth.get(request.priority) ?? 0) + 1,
          );
          tierDepth[request.priorityTier] += 1;
          if ((request.priorityBoost ?? 0) > 0) {
            boosted += 1;
          }
        }

        if (jsonMode) {
          await emitJsonSuccess({
            command: 'queue status',
            data: {
              total: prioritizedRequests.length,
              boosted,
              priorityDepth: Object.fromEntries(priorityDepth.entries()),
              basePriorityDepth: Object.fromEntries(basePriorityDepth.entries()),
              tierDepth,
              concurrency: ctx.config.queue.concurrency,
              escalation: ctx.config.queue.priority.escalation,
            },
            repoRoot: ctx.repo.repoRoot,
            runId: ctx.runId,
          });
          return;
        }

        const lines: string[] = [];
        lines.push(renderSectionHeader('Queue status', { width: 60, kind: 'minor' }));
        lines.push(
          ...formatKeyValues(
            [
              ['Total', `${prioritizedRequests.length} request(s)`],
              ['Boosted', `${boosted} request(s)`],
              [
                'Concurrency',
                `high ${ctx.config.queue.concurrency.tiers.high}, medium ${ctx.config.queue.concurrency.tiers.medium}, low ${ctx.config.queue.concurrency.tiers.low}`,
              ],
            ],
            { labelWidth: 12 },
          ),
        );
        const priorityLines: string[] = [];
        for (let priority = PRIORITY_MAX; priority >= PRIORITY_MIN; priority -= 1) {
          priorityLines.push(`P${priority}: ${priorityDepth.get(priority) ?? 0}`);
        }
        lines.push(
          ...formatKeyList(
            'Priority depth',
            `${prioritizedRequests.length} request(s)`,
            priorityLines,
            { labelWidth: 12 },
          ),
        );
        const basePriorityLines: string[] = [];
        for (let priority = PRIORITY_MAX; priority >= PRIORITY_MIN; priority -= 1) {
          basePriorityLines.push(`P${priority}: ${basePriorityDepth.get(priority) ?? 0}`);
        }
        lines.push(
          ...formatKeyList(
            'Base priority',
            `${prioritizedRequests.length} request(s)`,
            basePriorityLines,
            { labelWidth: 12 },
          ),
        );
        const nextSteps: string[] = [];
        if (prioritizedRequests.length > 0) {
          nextSteps.push('silvan queue run');
        } else {
          nextSteps.push('silvan task start --queue "Your task"');
        }
        lines.push(renderNextSteps(nextSteps));
        await logger.info(lines.join('\n'));
      }),
    );

  cli
    .command('queue run', 'Process queued task requests')
    .option('--concurrency <n>', 'Number of queue requests to process at once')
    .option('--continue-on-error', 'Keep processing queued requests after a failure')
    .action((options: QueueOptions) =>
      deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) => {
        const jsonMode = Boolean(options.json);
        const logger = deps.createCliLogger(ctx);
        const concurrencyOverride = options.concurrency
          ? deps.parseConcurrency(options.concurrency)
          : undefined;
        const tierConcurrency = ctx.config.queue.concurrency.tiers;
        const concurrencyMode = concurrencyOverride ? 'total' : 'tiered';
        const concurrency = concurrencyOverride ?? ctx.config.queue.concurrency.default;
        const continueOnError = Boolean(options.continueOnError);
        const requests = await listQueueRequests({ state: ctx.state });
        if (requests.length === 0) {
          if (jsonMode) {
            await emitJsonSuccess({
              command: 'queue run',
              data: {
                processed: 0,
                succeeded: 0,
                failed: 0,
                remaining: 0,
                concurrency,
                concurrencyMode,
                tierConcurrency,
                continueOnError,
                failures: [],
              },
              repoRoot: ctx.repo.repoRoot,
              runId: ctx.runId,
            });
          } else {
            await logger.info('No queued requests.');
          }
          return;
        }

        const prioritizedRequests = requests
          .map((request) => applyQueuePriority(request, ctx.config))
          .sort(sortByPriority);
        const requestLabels = new Map(
          prioritizedRequests.map((request) => [request.id, request.title]),
        );
        const requestPriorities = new Map(
          prioritizedRequests.map((request) => [
            request.id,
            {
              base: request.priority,
              effective: request.effectivePriority,
              tier: request.priorityTier,
            },
          ]),
        );
        const runOptions = {
          continueOnError,
          onRequest: async (request: (typeof prioritizedRequests)[number]) => {
            await withRunContext(
              {
                cwd: process.cwd(),
                mode: jsonMode ? 'json' : 'headless',
                lock: false,
                configOverrides: deps.buildConfigOverrides(options),
              },
              async (runCtx) =>
                deps.withAgentSessions(
                  Boolean(runCtx.config.ai.sessions.persist),
                  async (sessions) => {
                    const localInput: LocalTaskInput = {
                      title: request.title,
                      ...(request.description
                        ? { description: request.description }
                        : {}),
                      ...(request.acceptanceCriteria?.length
                        ? { acceptanceCriteria: request.acceptanceCriteria }
                        : {}),
                    };
                    await deps.startTaskFlow({
                      ctx: runCtx,
                      ...(sessions ? { sessions } : {}),
                      taskRef: request.title,
                      localInput,
                      printCd: false,
                    });
                  },
                ),
            );
          },
          onSuccess: async (request: (typeof prioritizedRequests)[number]) => {
            await deleteQueueRequest({ state: ctx.state, requestId: request.id });
          },
        };
        const result = concurrencyOverride
          ? await runQueueRequests({
              requests: prioritizedRequests,
              concurrency,
              ...runOptions,
            })
          : await runPriorityQueueRequests({
              requests: prioritizedRequests,
              tierConcurrency,
              ...runOptions,
            });

        const remainingRequests = await listQueueRequests({ state: ctx.state });
        const remaining = remainingRequests.length;
        const failures = result.failures.map((failure) => ({
          id: failure.id,
          title: requestLabels.get(failure.id),
          priority: requestPriorities.get(failure.id)?.effective,
          message: failure.message,
        }));

        if (jsonMode) {
          await emitJsonResult({
            command: 'queue run',
            success: result.failed === 0,
            data: {
              processed: result.processed,
              succeeded: result.succeeded,
              failed: result.failed,
              remaining,
              concurrency,
              concurrencyMode,
              tierConcurrency,
              continueOnError,
              failures,
            },
            ...(result.failed === 0
              ? {}
              : {
                  error: {
                    code: 'queue.run_failed',
                    message: 'One or more queued requests failed.',
                    details: { failures },
                    suggestions: ['Review failures, then run `silvan queue run` again.'],
                  },
                }),
            repoRoot: ctx.repo.repoRoot,
            runId: ctx.runId,
          });
          if (result.failed > 0) {
            process.exitCode = 1;
          }
          return;
        }

        const lines: string[] = [];
        const title =
          result.failed > 0 ? 'Queue processed with errors' : 'Queue processed';
        lines.push(renderSectionHeader(title, { width: 60, kind: 'minor' }));
        lines.push(
          ...formatKeyValues(
            [
              ['Processed', `${result.processed} request(s)`],
              ['Succeeded', `${result.succeeded} request(s)`],
              ['Failed', `${result.failed} request(s)`],
              ['Remaining', `${remaining} request(s)`],
              [
                'Concurrency',
                concurrencyOverride
                  ? `${concurrency}`
                  : `tiered (high ${tierConcurrency.high}, medium ${tierConcurrency.medium}, low ${tierConcurrency.low})`,
              ],
              ['Continue on error', continueOnError ? 'Yes' : 'No'],
            ],
            { labelWidth: 12 },
          ),
        );
        if (failures.length > 0) {
          const failureLines = failures.map((failure) => {
            const label = failure.title ?? failure.id;
            return failure.priority
              ? `${label} (P${failure.priority}): ${failure.message}`
              : `${label}: ${failure.message}`;
          });
          lines.push(
            ...formatKeyList('Failures', `${failures.length} request(s)`, failureLines, {
              labelWidth: 12,
            }),
          );
        }
        const nextSteps = ['silvan run list'];
        if (remaining > 0 || result.failed > 0) {
          nextSteps.push('silvan queue run');
        }
        lines.push(renderNextSteps(nextSteps));
        await logger.info(lines.join('\n'));
        if (result.failed > 0) {
          process.exitCode = 1;
        }
      }),
    );

  cli
    .command(
      'queue priority <requestId> <priority>',
      'Update the priority of a queued task',
    )
    .action((requestId: string, priority: string, options: QueueOptions) =>
      deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) => {
        const jsonMode = Boolean(options.json);
        const logger = deps.createCliLogger(ctx);
        const nextPriority = deps.parseQueuePriority(
          priority,
          ctx.config.queue.priority.default,
        );
        const updated = await setQueueRequestPriority({
          state: ctx.state,
          requestId,
          priority: nextPriority,
        });
        if (!updated) {
          throw new SilvanError({
            code: 'queue.request_not_found',
            message: `Queue request not found: ${requestId}`,
            userMessage: 'Queue request not found.',
            kind: 'not_found',
            nextSteps: ['Run `silvan queue status` to list queued requests.'],
          });
        }
        if (jsonMode) {
          await emitJsonSuccess({
            command: 'queue priority',
            data: {
              requestId,
              priority: nextPriority,
              updatedAt: updated.updatedAt,
            },
            repoRoot: ctx.repo.repoRoot,
            runId: ctx.runId,
          });
          return;
        }
        if (options.quiet) {
          return;
        }
        await logger.info(
          renderSuccessSummary({
            title: 'Queue priority updated',
            details: [
              ['Request ID', requestId],
              ['Priority', `${nextPriority}`],
            ],
            nextSteps: ['silvan queue status', 'silvan queue run'],
          }),
        );
      }),
    );
}
