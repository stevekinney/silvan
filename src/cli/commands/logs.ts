import { join } from 'node:path';

import type { CAC } from 'cac';

import { loadConfig } from '../../config/load';
import type { ConfigInput } from '../../config/schema';
import { SilvanError } from '../../core/errors';
import { detectRepoContext } from '../../core/repo';
import type { Event } from '../../events/schema';
import { initStateStore } from '../../state/store';
import { emitJsonSuccess } from '../json-output';
import type { CliOptions } from '../types';

export type LogCommandDeps = {
  buildConfigOverrides: (options: CliOptions) => ConfigInput;
  parseNumberFlag: (value: string | undefined) => number | null;
};

export function registerLogCommands(cli: CAC, deps: LogCommandDeps): void {
  cli
    .command('logs <runId>', 'Show audit log for a run')
    .option('--tail <n>', 'Show the last N events')
    .action(async (runId: string, options: CliOptions & { tail?: string }) => {
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
      const logPath = join(state.auditDir, `${runId}.jsonl`);
      const logFile = Bun.file(logPath);
      if (!(await logFile.exists())) {
        throw new SilvanError({
          code: 'audit_log.not_found',
          message: `Audit log not found for run ${runId} (${logPath}).`,
          userMessage: `Audit log not found for run ${runId}.`,
          kind: 'not_found',
          details: { runId, logPath },
          nextSteps: ['Check the run ID with `silvan run list`.'],
        });
      }

      const content = await logFile.text();
      const lines = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const limit = deps.parseNumberFlag(options.tail);
      const selected = limit ? lines.slice(-limit) : lines;
      const events = selected
        .map((line) => parseAuditEvent(line))
        .filter((event): event is Event => event !== null);

      if (options.json) {
        await emitJsonSuccess({
          command: 'logs',
          data: { runId, events },
          repoRoot: repo.projectRoot,
        });
        return;
      }

      for (const event of events) {
        console.log(formatAuditEvent(event));
      }
    });
}

function parseAuditEvent(line: string): Event | null {
  try {
    return JSON.parse(line) as Event;
  } catch {
    return null;
  }
}

function formatAuditEvent(event: Event): string {
  const base = `${event.ts} [${event.level}] ${event.source} ${event.type}`;
  const message =
    event.message ?? (event.type === 'log.message' ? event.payload.message : undefined);
  if (message) {
    return `${base} - ${message}`;
  }
  if (event.error?.message) {
    return `${base} - ${event.error.message}`;
  }
  if (event.type === 'run.step') {
    return `${base} - ${event.payload.status}: ${event.payload.title}`;
  }
  if (event.type === 'run.finished') {
    return `${base} - ${event.payload.status} (${event.payload.durationMs}ms)`;
  }
  return base;
}
