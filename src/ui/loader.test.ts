import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { initStateStore } from '../state/store';
import { loadRunSnapshots } from './loader';

async function withTempRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-loader-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('loadRunSnapshots', () => {
  test('includes audit summaries and skips malformed lines', async () => {
    await withTempRepo(async (repoRoot) => {
      const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
      const runId = 'run-1';
      await state.writeRunState(runId, {
        run: {
          status: 'running',
          phase: 'plan',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      });
      const auditPath = join(state.auditDir, `${runId}.jsonl`);
      const lines = [
        JSON.stringify({ ts: '2025-01-01T00:00:00.000Z', type: 'run.started' }),
        'not-json',
        JSON.stringify({ ts: '2025-01-01T00:05:00.000Z', type: 'run.step' }),
        '{bad',
      ];
      await Bun.write(auditPath, lines.join('\n'));

      const page = await loadRunSnapshots(state, { limit: 5 });
      const summary = page.runs[0]?.eventSummary;
      expect(summary?.eventCount).toBe(4);
      expect(summary?.latestEventAt).toBe('2025-01-01T00:05:00.000Z');
    });
  });
});
