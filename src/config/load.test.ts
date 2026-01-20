import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { loadConfig } from './load';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-config-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    await fn(dir);
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
}

describe('loadConfig', () => {
  test('loads a TypeScript config', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'silvan.config.ts');
      await writeFile(path, `export default { naming: { worktreeDir: '.custom' } };`);
      const result = await loadConfig();
      expect(result.config.naming.worktreeDir).toBe('.custom');
    });
  });

  test('loads a JSON config', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'silvan.config.json');
      await writeFile(path, JSON.stringify({ naming: { worktreeDir: '.json' } }));
      const result = await loadConfig();
      expect(result.config.naming.worktreeDir).toBe('.json');
    });
  });

  test('rejects invalid config', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'silvan.config.json');
      await writeFile(
        path,
        JSON.stringify({ verify: { commands: [{ name: '', cmd: '' }] } }),
      );
      return expect(loadConfig()).rejects.toThrow('Invalid config');
    });
  });

  test('loads .env before reading environment overrides', async () => {
    await withTempDir(async (dir) => {
      const previous = Bun.env['GITHUB_TOKEN'];
      try {
        Bun.env['GITHUB_TOKEN'] = 'shell_token';
        await writeFile(join(dir, '.env'), 'GITHUB_TOKEN=env_token');
        await writeFile(join(dir, 'silvan.config.json'), JSON.stringify({}));
        const result = await loadConfig();
        expect(result.config.github.token).toBe('env_token');
      } finally {
        if (previous === undefined) {
          delete Bun.env['GITHUB_TOKEN'];
        } else {
          Bun.env['GITHUB_TOKEN'] = previous;
        }
      }
    });
  });

  test('uses the nearest config as the project root', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'silvan.config.json'), JSON.stringify({}));
      const nested = join(dir, 'apps', 'web');
      await mkdir(nested, { recursive: true });
      const result = await loadConfig(undefined, { cwd: nested });
      expect(result.projectRoot).toBe(dir);
    });
  });
});
