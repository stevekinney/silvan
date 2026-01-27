import type { CAC } from 'cac';

import {
  createConversationStore,
  exportConversationSnapshot,
  loadConversationSnapshot,
  renderConversationSummary,
  summarizeConversationSnapshot,
} from '../../ai/conversation';
import type { RunContext } from '../../core/context';
import type { EventMode } from '../../events/schema';
import { emitJsonSuccess } from '../json-output';
import { buildEmitContext, createCliLogger } from '../logger';
import { renderNextSteps, renderSectionHeader, renderSuccessSummary } from '../output';
import type { CliOptions } from '../types';

export type ConversationCommandDeps = {
  withCliContext: <T>(
    options: CliOptions | undefined,
    mode: EventMode,
    fn: (ctx: RunContext) => Promise<T>,
  ) => Promise<T>;
};

export function registerConversationCommands(
  cli: CAC,
  deps: ConversationCommandDeps,
): void {
  cli
    .command('convo show <runId>', 'Show conversation context')
    .option('--limit <limit>', 'Number of messages to show', { default: '20' })
    .action((runId: string, options: CliOptions & { limit?: string }) =>
      deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) => {
        const logger = createCliLogger(ctx);
        const snapshot = await loadConversationSnapshot(ctx.state, runId);
        if (!snapshot) {
          throw new Error(`No conversation found for run ${runId}`);
        }
        const limit = Math.max(1, Number(options.limit ?? 20) || 20);
        const summary = summarizeConversationSnapshot(snapshot, { limit });
        const nextSteps = [
          `silvan convo export ${runId} --format md`,
          `silvan convo optimize ${runId}`,
        ];
        if (options.json) {
          await emitJsonSuccess({
            command: 'convo show',
            data: { runId, summary },
            nextSteps,
            bus: ctx.events.bus,
            runId: ctx.runId,
            repoRoot: ctx.repo.repoRoot,
          });
          return;
        }
        if (options.quiet) {
          return;
        }
        const lines: string[] = [];
        lines.push(
          renderSectionHeader('Conversation summary', { width: 60, kind: 'minor' }),
        );
        lines.push(renderConversationSummary(summary));
        lines.push(renderNextSteps(nextSteps));
        await logger.info(lines.join('\n'));
      }),
    );

  cli
    .command('convo export <runId>', 'Export conversation snapshot')
    .option('--format <format>', 'json or md', { default: 'json' })
    .action((runId: string, options: CliOptions & { format?: string }) =>
      deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) => {
        const snapshot = await loadConversationSnapshot(ctx.state, runId);
        if (!snapshot) {
          throw new Error(`No conversation found for run ${runId}`);
        }
        const format = (options.format ?? 'json') as 'json' | 'md';
        if (format !== 'json' && format !== 'md') {
          throw new Error('Format must be json or md');
        }
        const content = exportConversationSnapshot(snapshot, { format });
        if (options.json) {
          await emitJsonSuccess({
            command: 'convo export',
            data: { runId, format, content },
            nextSteps: [`silvan convo show ${runId}`, `silvan convo optimize ${runId}`],
            bus: ctx.events.bus,
            runId: ctx.runId,
            repoRoot: ctx.repo.repoRoot,
          });
          return;
        }
        if (options.quiet) {
          return;
        }
        console.log(content);
      }),
    );

  cli
    .command('convo optimize <runId>', 'Optimize conversation context')
    .option('--force', 'Force optimization even if below thresholds')
    .action((runId: string, options: CliOptions & { force?: boolean }) =>
      deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) => {
        const logger = createCliLogger(ctx);
        const store = createConversationStore({
          runId,
          state: ctx.state,
          config: ctx.config,
          bus: ctx.events.bus,
          context: buildEmitContext(ctx),
        });
        const result = await store.optimize(options.force ? { force: true } : undefined);
        const nextSteps = [
          `silvan convo show ${runId}`,
          `silvan convo export ${runId} --format md`,
        ];

        if (options.json) {
          await emitJsonSuccess({
            command: 'convo optimize',
            data: {
              runId,
              metrics: result.metrics,
              backupPath: result.backupPath ?? null,
            },
            nextSteps,
            bus: ctx.events.bus,
            runId: ctx.runId,
            repoRoot: ctx.repo.repoRoot,
          });
          return;
        }
        if (options.quiet) {
          return;
        }
        const messageDetail = formatOptimizationMetric(
          result.metrics.beforeMessages,
          result.metrics.afterMessages,
        );
        const tokenDetail = formatOptimizationMetric(
          result.metrics.beforeTokens,
          result.metrics.afterTokens,
        );
        const details: Array<[string, string]> = [
          ['Run ID', runId],
          ['Messages', messageDetail],
          ['Tokens', tokenDetail],
          ['Compression', `${Math.round(result.metrics.compressionRatio * 100)}%`],
          ['Summary added', result.metrics.summaryAdded ? 'Yes' : 'No'],
        ];
        if (result.backupPath) {
          details.push(['Backup', result.backupPath]);
        }
        await logger.info(
          renderSuccessSummary({
            title: result.metrics.changed
              ? 'Conversation optimized'
              : 'Conversation checked',
            details,
            nextSteps,
          }),
        );
      }),
    );
}

function formatOptimizationMetric(before: number, after: number): string {
  if (before === after) return `${after}`;
  return `${before} -> ${after}`;
}
