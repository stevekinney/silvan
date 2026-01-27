import type { CAC } from 'cac';

import { buildAnalyticsReport } from '../../analytics/analytics';
import { loadConfig } from '../../config/load';
import type { ConfigInput } from '../../config/schema';
import { SilvanError } from '../../core/errors';
import { detectRepoContext } from '../../core/repo';
import { initStateStore } from '../../state/store';
import { parseTimeInput } from '../../utils/time';
import { buildAnalyticsNextSteps, renderAnalyticsReport } from '../analytics-output';
import { emitJsonSuccess } from '../json-output';
import type { CliOptions } from '../types';

export type AnalyticsCommandDeps = {
  buildConfigOverrides: (options: CliOptions) => ConfigInput;
  parseListFlag: (value: string | undefined) => string[] | null;
};

export function registerAnalyticsCommands(cli: CAC, deps: AnalyticsCommandDeps): void {
  cli
    .command('analytics', 'Run analytics and success reporting')
    .option('--since <time>', 'Filter runs starting after this time (e.g., 7d)')
    .option('--until <time>', 'Filter runs starting before this time (e.g., 2025-01-31)')
    .option('--provider <provider>', 'Filter by task provider (comma-separated)')
    .option('--repo <repo>', 'Filter by repository (comma-separated)')
    .action(
      async (
        options: CliOptions & {
          since?: string;
          until?: string;
          provider?: string;
          repo?: string;
        },
      ) => {
        const configResult = await loadConfig(deps.buildConfigOverrides(options), {
          cwd: process.cwd(),
        });
        const repo = await detectRepoContext({ cwd: configResult.projectRoot });
        const state = await initStateStore(repo.projectRoot, {
          lock: false,
          mode: configResult.config.state.mode,
          ...(configResult.config.state.root
            ? { root: configResult.config.state.root }
            : {}),
          metadataRepoRoot: repo.gitRoot,
        });

        const sinceInput = options.since?.trim();
        const untilInput = options.until?.trim();
        const since = sinceInput ? parseTimeInput(sinceInput) : undefined;
        if (sinceInput && !since) {
          throw new SilvanError({
            code: 'analytics.invalid_since',
            message: `Invalid --since value: ${sinceInput}`,
            userMessage: `Invalid --since value: ${sinceInput}`,
            kind: 'validation',
            nextSteps: ['Use a duration like 7d or an ISO timestamp.'],
          });
        }
        const until = untilInput ? parseTimeInput(untilInput) : undefined;
        if (untilInput && !until) {
          throw new SilvanError({
            code: 'analytics.invalid_until',
            message: `Invalid --until value: ${untilInput}`,
            userMessage: `Invalid --until value: ${untilInput}`,
            kind: 'validation',
            nextSteps: ['Use a duration like 7d or an ISO timestamp.'],
          });
        }
        if (since && until && since > until) {
          throw new SilvanError({
            code: 'analytics.invalid_range',
            message: `Invalid time range: ${since} is after ${until}`,
            userMessage: 'Invalid time range: --since must be before --until.',
            kind: 'validation',
            nextSteps: ['Swap the range or remove --until.'],
          });
        }

        const providerFilter = deps.parseListFlag(options.provider);
        const repoFilter = deps.parseListFlag(options.repo);
        const report = await buildAnalyticsReport({
          state,
          filters: {
            ...(since ? { since } : {}),
            ...(until ? { until } : {}),
            ...(providerFilter ? { providers: providerFilter } : {}),
            ...(repoFilter ? { repos: repoFilter } : {}),
          },
        });
        const nextSteps = buildAnalyticsNextSteps(report);

        if (options.json) {
          await emitJsonSuccess({
            command: 'analytics',
            data: report,
            nextSteps,
            repoRoot: repo.projectRoot,
          });
          return;
        }

        if (options.quiet) {
          return;
        }

        console.log(renderAnalyticsReport(report));
      },
    );
}
