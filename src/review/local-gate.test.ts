import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { configSchema } from '../config/schema';
import { generateLocalGateReport } from './local-gate';

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawnSync({ cmd, cwd });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString() || `Failed: ${cmd.join(' ')}`);
  }
}

async function setupRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-local-gate-'));
  await run(['git', 'init', '-b', 'main'], dir);
  await run(['git', 'config', 'user.name', 'Test'], dir);
  await run(['git', 'config', 'user.email', 'test@example.com'], dir);
  await writeFile(join(dir, 'README.md'), 'base');
  await run(['git', 'add', '.'], dir);
  await run(['git', 'commit', '-m', 'init'], dir);
  return dir;
}

describe('local gate', () => {
  it('flags env file and debug artifacts', async () => {
    const repo = await setupRepo();
    try {
      await run(['git', 'checkout', '-b', 'feature/test'], repo);
      await writeFile(join(repo, '.env'), 'SECRET=1');
      await writeFile(join(repo, 'src.ts'), 'console.log("debug")\n// TODO: fix\n');
      await run(['git', 'add', '.'], repo);
      await run(['git', 'commit', '-m', 'changes'], repo);

      const config = configSchema.parse({
        review: {
          localGate: {
            enabled: true,
            thresholds: { filesChangedWarn: 1, linesChangedWarn: 1 },
          },
        },
      });
      const report = await generateLocalGateReport({
        repoRoot: repo,
        baseBranch: 'main',
        branchName: 'feature/test',
        config,
        context: { runId: 'test', repoRoot: repo, mode: 'headless' },
      });

      const ids = report.findings.map((finding) => finding.id);
      expect(ids).toContain('envFile');
      expect(ids).toContain('consoleLog');
      expect(ids).toContain('todo');
      expect(report.ok).toBeFalse();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
