import type { CAC } from 'cac';

import type { RunContext } from '../../core/context';
import { collectDoctorReport } from '../../diagnostics/doctor';
import type { EventMode } from '../../events/schema';
import { emitJsonSuccess } from '../json-output';
import { colors, renderSectionHeader } from '../output';
import { renderNextSteps } from '../task-start-output';
import type { CliOptions } from '../types';

type DoctorCommandDeps = {
  withCliContext: <T>(
    options: CliOptions,
    mode: EventMode,
    fn: (ctx: RunContext) => Promise<T>,
  ) => Promise<T>;
};

export function registerDoctorCommands(cli: CAC, deps: DoctorCommandDeps): void {
  cli
    .command('doctor', 'Check environment and configuration')
    .option('--network', 'Check network connectivity to providers')
    .action(async (options: CliOptions) => {
      const mode: EventMode = options.json ? 'json' : 'headless';
      await deps.withCliContext(options, mode, async (ctx) => {
        const report = await collectDoctorReport(ctx, {
          network: Boolean(options.network),
        });
        if (options.json) {
          await emitJsonSuccess({
            command: 'doctor',
            data: report,
            bus: ctx.events.bus,
            runId: ctx.runId,
            repoRoot: ctx.repo.repoRoot,
          });
        } else {
          if (options.quiet) {
            if (!report.ok) {
              process.exitCode = 1;
            }
            return;
          }
          const lines: string[] = [];
          lines.push(renderSectionHeader('Doctor report', { width: 60, kind: 'minor' }));
          for (const check of report.checks) {
            const prefix = check.ok ? colors.success('ok') : colors.error('fail');
            lines.push(`${prefix} ${check.name} ${check.detail}`);
          }
          lines.push(renderNextSteps(['silvan config validate', 'silvan config show']));
          console.log(lines.join('\n'));
        }
        if (!report.ok) {
          process.exitCode = 1;
        }
      });
    });
}
