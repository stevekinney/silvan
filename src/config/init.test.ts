import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { InitAnswers } from './init';
import { applyInitSuggestions, collectInitContext } from './init';

async function run(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawnSync({ cmd, cwd });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString() || `Failed: ${cmd.join(' ')}`);
  }
  return proc.stdout.toString().trim();
}

async function withTempRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-init-'));
  try {
    await run(['git', 'init', '-b', 'main'], dir);
    await run(['git', 'config', 'user.name', 'Test'], dir);
    await run(['git', 'config', 'user.email', 'test@example.com'], dir);
    await writeFile(join(dir, 'README.md'), 'base');
    await run(['git', 'add', '.'], dir);
    await run(['git', 'commit', '-m', 'init'], dir);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('init detection', () => {
  test('detects package manager and verify commands', async () => {
    await withTempRepo(async (dir) => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          scripts: {
            lint: 'eslint .',
            typecheck: 'tsc -p tsconfig.json',
            test: 'vitest',
          },
        }),
      );
      await writeFile(join(dir, 'pnpm-lock.yaml'), '');

      const context = await collectInitContext(dir);
      expect(context.detection.packageManager).toBe('pnpm');
      expect(context.detection.verifyCommands).toEqual([
        { name: 'lint', cmd: 'pnpm run lint' },
        { name: 'typecheck', cmd: 'pnpm run typecheck' },
        { name: 'test', cmd: 'pnpm run test' },
      ]);
    });
  });

  test('detects default branch from origin HEAD', async () => {
    await withTempRepo(async (dir) => {
      await run(
        ['git', 'remote', 'add', 'origin', 'https://github.com/acme/repo.git'],
        dir,
      );
      const head = await run(['git', 'rev-parse', 'HEAD'], dir);
      await run(['git', 'update-ref', 'refs/remotes/origin/trunk', head], dir);
      await run(
        ['git', 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'],
        dir,
      );

      const context = await collectInitContext(dir);
      expect(context.detection.defaultBranch).toBe('trunk');
    });
  });

  test('applyInitSuggestions merges providers and verify commands', async () => {
    const defaults: InitAnswers = {
      worktreeDir: '.worktrees',
      enabledProviders: ['local'],
      defaultProvider: 'local',
      verifyCommands: [{ name: 'test', cmd: 'bun test' }],
    };
    const suggestions: Partial<InitAnswers> = {
      enabledProviders: ['github'],
      defaultProvider: 'github',
      verifyCommands: [
        { name: 'lint', cmd: 'bun run lint' },
        { name: 'test', cmd: 'bun run test' },
      ],
    };

    const merged = applyInitSuggestions(defaults, suggestions);

    expect(merged.enabledProviders).toEqual(['local', 'github']);
    expect(merged.defaultProvider).toBe('github');
    expect(merged.verifyCommands).toEqual([
      { name: 'test', cmd: 'bun test' },
      { name: 'lint', cmd: 'bun run lint' },
    ]);
  });

  test('applyInitSuggestions adds the default provider when missing', async () => {
    const defaults: InitAnswers = {
      worktreeDir: '.worktrees',
      enabledProviders: ['local'],
      defaultProvider: 'local',
      verifyCommands: [],
    };
    const suggestions: Partial<InitAnswers> = {
      defaultProvider: 'github',
    };

    const merged = applyInitSuggestions(defaults, suggestions);

    expect(merged.enabledProviders).toEqual(['local', 'github']);
    expect(merged.defaultProvider).toBe('github');
  });
});
