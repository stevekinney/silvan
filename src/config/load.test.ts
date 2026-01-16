import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});
