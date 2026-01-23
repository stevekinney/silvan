import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { getQueueRequest, setQueueRequestPriority, writeQueueRequest } from './queue';
import { initStateStore } from './store';

async function withTempRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-queue-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('queue state', () => {
  test('updates queue priority in place', async () => {
    await withTempRepo(async (repoRoot) => {
      const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
      const requestId = crypto.randomUUID();
      await writeQueueRequest({
        state,
        request: {
          id: requestId,
          type: 'start-task',
          title: 'Priority task',
          priority: 4,
          createdAt: new Date().toISOString(),
        },
      });

      const updated = await setQueueRequestPriority({
        state,
        requestId,
        priority: 9,
      });

      expect(updated?.priority).toBe(9);
      expect(updated?.updatedAt).toBeTruthy();

      const reloaded = await getQueueRequest({ state, requestId });
      expect(reloaded?.priority).toBe(9);
      expect(reloaded?.updatedAt).toBeTruthy();
    });
  });
});
