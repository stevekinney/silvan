import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { configSchema } from '../config/schema';
import { writeQueueRequest } from '../state/queue';
import { initStateStore } from '../state/store';
import { loadQueueRequests, loadWorktrees } from './loader';

async function withTempRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-ui-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const env = { ...process.env };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  delete env['GIT_INDEX_FILE'];
  const proc = Bun.spawn(cmd, { cwd, env });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed: ${stderr || stdout}`);
  }
}

describe('ui loader', () => {
  test('loads queue requests for current repo', async () => {
    await withTempRepo(async (repoRoot) => {
      const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
      const requestId = crypto.randomUUID();
      const config = configSchema.parse({});
      await writeQueueRequest({
        state,
        request: {
          id: requestId,
          type: 'start-task',
          title: 'Ship the dashboard panel',
          createdAt: new Date().toISOString(),
        },
      });

      const requests = await loadQueueRequests(state, config, { scope: 'current' });
      expect(requests.length).toBe(1);
      expect(requests[0]?.id).toBe(requestId);
      expect(requests[0]?.title).toBe('Ship the dashboard panel');
      expect(requests[0]?.createdAt).toBeTruthy();
      expect(requests[0]?.priority).toBe(5);
      expect(requests[0]?.effectivePriority).toBe(5);
      expect(requests[0]?.repoLabel).toBeTruthy();
    });
  });

  test('loads worktrees for current repo', async () => {
    await withTempRepo(async (repoRoot) => {
      await run(['git', 'init', '-b', 'main'], repoRoot);
      await run(['git', 'config', 'user.name', 'Test'], repoRoot);
      await run(['git', 'config', 'user.email', 'test@example.com'], repoRoot);
      await writeFile(join(repoRoot, 'README.md'), '# Test');
      await run(['git', 'add', 'README.md'], repoRoot);
      await run(['git', 'commit', '-m', 'init'], repoRoot);
      await run(
        ['git', 'worktree', 'add', '.worktrees/test-worktree', '-b', 'feature/test'],
        repoRoot,
      );

      const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
      const originalGitDir = process.env['GIT_DIR'];
      const originalGitWorkTree = process.env['GIT_WORK_TREE'];
      const originalGitIndexFile = process.env['GIT_INDEX_FILE'];
      delete process.env['GIT_DIR'];
      delete process.env['GIT_WORK_TREE'];
      delete process.env['GIT_INDEX_FILE'];
      let worktrees = [] as Awaited<ReturnType<typeof loadWorktrees>>;
      try {
        worktrees = await loadWorktrees(state, { scope: 'current' });
      } finally {
        if (originalGitDir) process.env['GIT_DIR'] = originalGitDir;
        if (originalGitWorkTree) process.env['GIT_WORK_TREE'] = originalGitWorkTree;
        if (originalGitIndexFile) process.env['GIT_INDEX_FILE'] = originalGitIndexFile;
      }
      const entry = worktrees.find((worktree) => worktree.branch === 'feature/test');
      expect(entry).toBeTruthy();
      expect(entry?.relativePath).toBe('.worktrees/test-worktree');
      expect(entry?.isDirty).toBe(false);
      expect(entry?.lastActivityAt).toBeTruthy();
    });
  });
});
