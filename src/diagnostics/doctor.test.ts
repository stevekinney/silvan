import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { createRunContext } from '../core/context';
import { collectDoctorReport } from './doctor';

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawnSync({ cmd, cwd });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString() || `Failed: ${cmd.join(' ')}`);
  }
}

async function setupRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-doctor-'));
  await run(['git', 'init', '-b', 'main'], dir);
  await run(['git', 'config', 'user.name', 'Test'], dir);
  await run(['git', 'config', 'user.email', 'test@example.com'], dir);
  await writeFile(join(dir, 'README.md'), 'base');
  await run(['git', 'add', '.'], dir);
  await run(['git', 'commit', '-m', 'init'], dir);
  return dir;
}

describe('doctor', () => {
  it('returns a structured report', async () => {
    const repo = await setupRepo();
    const stateRoot = join(repo, '.state');
    const ctx = await createRunContext({
      cwd: repo,
      mode: 'headless',
      configOverrides: { state: { root: stateRoot, mode: 'global' } },
    });

    try {
      const report = await collectDoctorReport(ctx, { network: false });
      expect(report.ok).toBeDefined();
      const repoResolved = await realpath(repo);
      const reportedResolved = await realpath(report.context.repoRoot);
      expect(reportedResolved).toBe(repoResolved);
      const artifactsPath = report.state.paths['artifacts'];
      expect(artifactsPath).toBeDefined();
      if (artifactsPath) {
        expect(artifactsPath.length).toBeGreaterThan(0);
      }
      expect(report.checks.length).toBeGreaterThan(0);
    } finally {
      await ctx.state.lockRelease();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
