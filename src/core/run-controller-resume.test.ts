import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { createRunContext } from './context';
import { resumeRun } from './run-controller';

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-resume-'));
  const init = Bun.spawnSync(['git', 'init'], { cwd: dir });
  if (init.exitCode !== 0) {
    throw new Error(`git init failed: ${init.stderr?.toString() ?? ''}`);
  }
  const name = Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: dir });
  if (name.exitCode !== 0) {
    throw new Error(`git config user.name failed: ${name.stderr?.toString() ?? ''}`);
  }
  const email = Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], {
    cwd: dir,
  });
  if (email.exitCode !== 0) {
    throw new Error(`git config user.email failed: ${email.stderr?.toString() ?? ''}`);
  }
  await Bun.write(join(dir, 'README.md'), '# Test\n');
  const add = Bun.spawnSync(['git', 'add', '.'], { cwd: dir });
  if (add.exitCode !== 0) {
    throw new Error(`git add failed: ${add.stderr?.toString() ?? ''}`);
  }
  const commit = Bun.spawnSync(['git', 'commit', '-m', 'init'], { cwd: dir });
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr?.toString() ?? ''}`);
  }
  return dir;
}

describe('resumeRun', () => {
  it('does not re-enter completed runs', async () => {
    const repoRoot = await initRepo();
    try {
      const ctx = await createRunContext({
        cwd: repoRoot,
        mode: 'headless',
        lock: false,
      });
      await ctx.state.updateRunState(ctx.runId, (data) => ({
        ...data,
        run: {
          version: '1.0.0',
          status: 'success',
          phase: 'complete',
          updatedAt: new Date().toISOString(),
        },
        plan: {
          summary: 'Plan',
          steps: [],
        },
      }));

      await resumeRun(ctx, {});

      const snapshot = await ctx.state.readRunState(ctx.runId);
      const run = (snapshot?.data as Record<string, unknown>)?.['run'] as {
        status?: string;
        phase?: string;
      };
      expect(run.status).toBe('success');
      expect(run.phase).toBe('complete');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
