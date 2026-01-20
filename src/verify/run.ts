import type { Config } from '../config/schema';
import { findFreePort, parsePort } from '../utils/port';

const DEFAULT_VERIFY_PORT = 4173;
const VERIFY_HOST = '127.0.0.1';
const VERIFY_PORT_ENV = 'SILVAN_VERIFY_PORT';
const VERIFY_BASE_URL_ENV = 'SILVAN_VERIFY_BASE_URL';

async function buildVerifyEnv(): Promise<NodeJS.ProcessEnv> {
  const envPort = process.env[VERIFY_PORT_ENV];
  const port = envPort
    ? parsePort(envPort, VERIFY_PORT_ENV)
    : await findFreePort(DEFAULT_VERIFY_PORT);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [VERIFY_PORT_ENV]: String(port),
    PORT: String(port),
  };
  if (!env[VERIFY_BASE_URL_ENV]) {
    env[VERIFY_BASE_URL_ENV] = `http://${VERIFY_HOST}:${port}`;
  }
  return env;
}

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

  const env = await buildVerifyEnv();
  const results: VerifyResult['results'] = [];
  for (const cmd of commands) {
    const argv = cmd.args?.length
      ? [cmd.cmd, ...cmd.args]
      : [config.verify.shell ?? Bun.env['SHELL'] ?? 'sh', '-lc', cmd.cmd];
    const proc = Bun.spawn(argv, { cwd: options?.cwd ?? process.cwd(), env });
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
