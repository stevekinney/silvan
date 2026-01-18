import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { config as loadDotenv } from 'dotenv';

export type EnvLoadSummary = {
  path?: string;
  keys: string[];
};

let lastSummary: EnvLoadSummary | null = null;

function logDebug(message: string): void {
  if (!process.env['SILVAN_DEBUG']) return;
  console.log(`[debug] ${message}`);
}

async function resolveGitRoot(cwd: string): Promise<string | null> {
  const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function loadProjectEnv(options: {
  configPath?: string | null;
  cwd?: string;
}): Promise<EnvLoadSummary> {
  const cwd = options.cwd ?? process.cwd();
  const envRoot = options.configPath
    ? dirname(options.configPath)
    : ((await resolveGitRoot(cwd)) ?? cwd);
  const envPath = join(envRoot, '.env');

  if (!existsSync(envPath)) {
    lastSummary = { keys: [] };
    return lastSummary;
  }

  logDebug(`Loading .env from ${envPath}`);
  const result = loadDotenv({ path: envPath, override: true, quiet: true });
  if (result.error) {
    logDebug(`Failed to load .env: ${result.error.message}`);
  }

  const keys = result.parsed ? Object.keys(result.parsed) : [];
  if (result.parsed) {
    for (const [key, value] of Object.entries(result.parsed)) {
      Bun.env[key] = value;
    }
  }
  logDebug(`Loaded ${keys.length} environment variable${keys.length === 1 ? '' : 's'}`);

  lastSummary = { path: envPath, keys };
  return lastSummary;
}

export function getLoadedEnvSummary(): EnvLoadSummary | null {
  return lastSummary;
}
