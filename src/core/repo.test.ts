import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { detectRepoContext } from './repo';

async function runGit(args: string[], cwd: string): Promise<void> {
  const env = { ...process.env };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  delete env['GIT_INDEX_FILE'];
  const proc = Bun.spawn(['git', ...args], { cwd, env });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`);
  }
}

async function withTempRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-repo-'));
  try {
    await runGit(['init', '-b', 'main'], dir);
    await runGit(['config', 'user.name', 'Test'], dir);
    await runGit(['config', 'user.email', 'test@example.com'], dir);
    await writeFile(join(dir, 'README.md'), '# Test');
    await runGit(['add', 'README.md'], dir);
    await runGit(['commit', '-m', 'init'], dir);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('detectRepoContext', () => {
  test('does not mark subdirectories as worktrees', async () => {
    await withTempRepo(async (repoRoot) => {
      const nested = join(repoRoot, 'packages', 'app');
      await mkdir(nested, { recursive: true });
      const context = await detectRepoContext({ cwd: nested });
      expect(context.isWorktree).toBe(false);
      expect(context.gitDir).toBe(context.gitCommonDir);
      expect(context.gitRoot).toBe(await realpath(repoRoot));
      expect(context.projectRoot).toBe(resolve(nested));
    });
  });

  test('marks actual worktrees as worktrees', async () => {
    await withTempRepo(async (repoRoot) => {
      const worktreePath = join(repoRoot, '.worktrees', 'feature-test');
      await mkdir(join(repoRoot, '.worktrees'), { recursive: true });
      await runGit(
        ['worktree', 'add', worktreePath, '-b', 'feature/test-worktree'],
        repoRoot,
      );
      const context = await detectRepoContext({ cwd: worktreePath });
      expect(context.isWorktree).toBe(true);
      expect(context.gitDir).not.toBe(context.gitCommonDir);
      expect(context.gitRoot).toBe(await realpath(worktreePath));
      expect(context.projectRoot).toBe(resolve(worktreePath));
      await runGit(['worktree', 'remove', '--force', worktreePath], repoRoot);
    });
  });
});
