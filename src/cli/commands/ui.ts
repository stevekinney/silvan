import type { CAC } from 'cac';

import { requireGitHubAuth, requireGitHubConfig } from '../../config/validate';
import type { RunContext } from '../../core/context';
import { SilvanError } from '../../core/errors';
import type { EventMode } from '../../events/schema';
import { mountDashboard, startPrSnapshotPoller } from '../../ui';
import { emitJsonError } from '../json-output';
import type { CliOptions } from '../types';

type UiCommandDeps = {
  withCliContext: <T>(
    options: CliOptions,
    mode: EventMode,
    fn: (ctx: RunContext) => Promise<T>,
    extra?: { lock?: boolean; runId?: string; modelRouting?: boolean },
  ) => Promise<T>;
};

export function registerUiCommands(cli: CAC, deps: UiCommandDeps): void {
  cli.command('ui', 'Launch the Ink dashboard').action(async (options: CliOptions) => {
    if (options.json) {
      await emitJsonError({
        command: 'ui',
        error: new SilvanError({
          code: 'ui.json_unsupported',
          message: 'JSON output is not supported for the UI command.',
          userMessage: 'JSON output is not supported for the UI command.',
          kind: 'validation',
          nextSteps: ['Run `silvan ui` without --json.'],
        }),
      });
      process.exitCode = 1;
      return;
    }
    if (options.noUi) {
      throw new Error('The --no-ui flag cannot be used with silvan ui.');
    }
    await deps.withCliContext(
      options,
      'ui',
      async (ctx) => {
        let stopPolling: () => void;
        try {
          const githubToken = requireGitHubAuth(ctx.config);
          const github = await requireGitHubConfig({
            config: ctx.config,
            repoRoot: ctx.repo.repoRoot,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          });
          stopPolling = startPrSnapshotPoller({
            owner: github.owner,
            repo: github.repo,
            token: githubToken,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          });
        } catch {
          stopPolling = () => {};
        }

        try {
          await mountDashboard(ctx.events.bus, ctx.state, ctx.config);
        } finally {
          stopPolling();
        }
      },
      { lock: false },
    );
  });
}
