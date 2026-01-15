import type { Config } from '../config/schema';

export type VerifyResult = {
  ok: boolean;
  results: Array<{
    name: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
};

export async function runVerifyCommands(
  config: Config,
  options?: { names?: string[]; cwd?: string },
): Promise<VerifyResult> {
  const commands = config.verify.commands.filter((cmd) =>
    options?.names?.length ? options.names.includes(cmd.name) : true,
  );
  if (commands.length === 0) {
    return { ok: true, results: [] };
  }

  const results: VerifyResult['results'] = [];
  for (const cmd of commands) {
    const proc = Bun.spawn(cmd.cmd.split(' '), {
      cwd: options?.cwd ?? process.cwd(),
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    results.push({ name: cmd.name, exitCode, stdout, stderr });
    if (exitCode !== 0 && config.verify.failFast) {
      return { ok: false, results };
    }
  }

  return { ok: results.every((r) => r.exitCode === 0), results };
}
