import type { CAC } from 'cac';

import type { AssistSuggestion } from '../../ai/cognition/assist';
import { loadConfig } from '../../config/load';
import type { ConfigInput } from '../../config/schema';
import { normalizeError } from '../../core/errors';
import { renderCliError } from '../errors';
import { emitJsonError, emitJsonResult, emitJsonSuccess } from '../json-output';
import { colors, formatKeyValues, padLabel, renderSectionHeader } from '../output';
import { renderNextSteps } from '../task-start-output';
import type { CliOptions } from '../types';

type ConfigCommandDeps = {
  buildConfigOverrides: (options: CliOptions) => ConfigInput;
  maybeSuggestCliRecovery: (options: {
    error: ReturnType<typeof normalizeError>;
    command: string;
  }) => Promise<AssistSuggestion | null>;
  getRegisteredCommandNames: () => string[];
};

export function registerConfigCommands(cli: CAC, deps: ConfigCommandDeps): void {
  cli
    .command('config show', 'Display resolved configuration')
    .action(async (options: CliOptions) => {
      const { config, source } = await loadConfig(deps.buildConfigOverrides(options));
      if (options.json) {
        await emitJsonSuccess({
          command: 'config show',
          data: { source, config },
        });
        return;
      }
      if (options.quiet) {
        return;
      }
      const lines: string[] = [];
      lines.push(renderSectionHeader('Configuration', { width: 60, kind: 'minor' }));
      lines.push(
        ...formatKeyValues(
          [['Source', source?.path ?? 'defaults (no config file found)']],
          { labelWidth: 14 },
        ),
      );

      lines.push('');
      lines.push(renderSectionHeader('Key settings', { width: 60, kind: 'minor' }));
      lines.push(
        ...formatKeyValues(
          [
            ['Default branch', config.repo.defaultBranch],
            ['Branch prefix', config.naming.branchPrefix],
            ['Worktree dir', config.naming.worktreeDir],
            ['State mode', config.state.mode],
          ],
          { labelWidth: 14 },
        ),
      );

      lines.push('');
      lines.push(renderSectionHeader('AI settings', { width: 60, kind: 'minor' }));
      const aiSettings: Array<[string, string]> = [
        ['Default model', config.ai.models.default ?? 'auto'],
        ['Max turns', String(config.ai.budgets.default.maxTurns ?? 'unset')],
      ];
      if (typeof config.ai.budgets.default.maxBudgetUsd === 'number') {
        aiSettings.push(['Max budget', `$${config.ai.budgets.default.maxBudgetUsd}`]);
      }
      lines.push(...formatKeyValues(aiSettings, { labelWidth: 14 }));

      lines.push('');
      lines.push(renderSectionHeader('Task providers', { width: 60, kind: 'minor' }));
      lines.push(
        ...formatKeyValues(
          [['Enabled', config.task.providers.enabled.join(', ') || 'none']],
          { labelWidth: 14 },
        ),
      );

      lines.push('');
      lines.push(renderSectionHeader('Verify commands', { width: 60, kind: 'minor' }));
      if (config.verify.commands.length === 0) {
        lines.push(
          ...formatKeyValues([['Status', 'None configured']], { labelWidth: 14 }),
        );
      } else {
        lines.push(
          ...config.verify.commands.map((cmd) => `${padLabel(cmd.name, 14)} ${cmd.cmd}`),
        );
      }

      lines.push(renderNextSteps(['silvan config validate', 'silvan doctor']));
      console.log(lines.join('\n'));
    });

  cli
    .command('config validate', 'Validate configuration without running')
    .action(async (options: CliOptions) => {
      try {
        const { config, source } = await loadConfig(deps.buildConfigOverrides(options));
        const checks: Array<{ name: string; ok: boolean; message: string }> = [];

        checks.push({
          name: 'Config file',
          ok: true,
          message: source ? `Loaded from ${source.path}` : 'Using defaults',
        });

        const hasGitHubToken = Boolean(
          config.github.token || process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'],
        );
        checks.push({
          name: 'GitHub token',
          ok: hasGitHubToken,
          message: hasGitHubToken
            ? 'Found'
            : 'Missing (set GITHUB_TOKEN or configure github.token)',
        });

        if (config.task.providers.enabled.includes('linear')) {
          const hasLinearToken = Boolean(
            config.linear.token || process.env['LINEAR_API_KEY'],
          );
          checks.push({
            name: 'Linear token',
            ok: hasLinearToken,
            message: hasLinearToken
              ? 'Found'
              : 'Missing (set LINEAR_API_KEY or configure linear.token)',
          });
        }

        const hasVerifyCommands = config.verify.commands.length > 0;
        checks.push({
          name: 'Verify commands',
          ok: hasVerifyCommands,
          message: hasVerifyCommands
            ? `${config.verify.commands.length} command(s) configured`
            : 'None configured (runs will skip verification)',
        });

        if (options.json) {
          const allOk = checks.every((c) => c.ok);
          await emitJsonResult({
            command: 'config validate',
            success: allOk,
            data: { ok: allOk, checks },
            ...(allOk
              ? {}
              : {
                  error: {
                    code: 'config.validation_warnings',
                    message: 'Configuration checks returned warnings.',
                    details: {
                      warnings: checks.filter((check) => !check.ok),
                    },
                    suggestions: ['Run `silvan config show` for details.'],
                  },
                }),
          });
          if (!allOk) {
            process.exitCode = 1;
          }
          return;
        }

        if (options.quiet) {
          if (!checks.every((c) => c.ok)) {
            process.exitCode = 1;
          }
          return;
        }

        const lines: string[] = [];
        lines.push(
          renderSectionHeader('Configuration checks', { width: 60, kind: 'minor' }),
        );
        for (const check of checks) {
          const prefix = check.ok ? colors.success('ok') : colors.warning('warn');
          lines.push(`${prefix}  ${check.name}: ${check.message}`);
        }

        const allOk = checks.every((c) => c.ok);
        if (!allOk) {
          lines.push('');
          lines.push('Some checks have warnings. Fix them for full functionality.');
          process.exitCode = 1;
        } else {
          lines.push('');
          lines.push('Configuration is valid.');
        }

        lines.push(renderNextSteps(['silvan config show', 'silvan doctor']));
        console.log(lines.join('\n'));
      } catch (error) {
        const normalized = normalizeError(error);
        const assistant = await deps.maybeSuggestCliRecovery({
          error: normalized,
          command: 'config validate',
        });
        if (options.json) {
          await emitJsonError({
            command: 'config validate',
            error: normalized,
            assistant,
          });
        } else {
          const rendered = renderCliError(normalized, {
            debug: Boolean(options.debug),
            trace: Boolean(options.trace),
            commandNames: deps.getRegisteredCommandNames(),
            ...(assistant ? { assistant } : {}),
          });
          console.error(rendered.message);
        }
        process.exitCode = 1;
      }
    });
}
