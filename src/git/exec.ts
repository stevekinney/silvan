import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';

export type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export async function runGit(
  args: string[],
  options: {
    cwd: string;
    bus?: EventBus | undefined;
    context: EmitContext;
  },
): Promise<GitResult> {
  const start = performance.now();
  const env = { ...process.env };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  delete env['GIT_INDEX_FILE'];

  if (options.bus) {
    await options.bus.emit(
      createEnvelope({
        type: 'git.command_started',
        source: 'git',
        level: 'debug',
        context: options.context,
        payload: { cmd: 'git', args, cwd: options.cwd },
      }),
    );
  }

  const proc = Bun.spawn(['git', ...args], { cwd: options.cwd, env });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const durationMs = Math.round(performance.now() - start);

  if (options.bus) {
    await options.bus.emit(
      createEnvelope({
        type: 'git.command_finished',
        source: 'git',
        level: exitCode === 0 ? 'debug' : 'error',
        context: options.context,
        payload: {
          cmd: 'git',
          args,
          cwd: options.cwd,
          exitCode,
          durationMs,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        },
      }),
    );
  }

  return { stdout, stderr, exitCode, durationMs };
}
