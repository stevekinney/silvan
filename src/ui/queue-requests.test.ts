import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { configSchema } from '../config/schema';
import { initStateStore } from '../state/store';
import { createRunSnapshotCache } from './loader';
import { enqueueQueueRequest } from './queue-requests';

async function withTempRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-queue-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('queue requests', () => {
  test('refreshes queue results after multiple submissions', async () => {
    await withTempRepo(async (repoRoot) => {
      const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
      const cache = createRunSnapshotCache();
      const config = configSchema.parse({});

      await enqueueQueueRequest({
        state,
        config,
        cache,
        scope: 'current',
        title: 'First request',
      });

      const updated = await enqueueQueueRequest({
        state,
        config,
        cache,
        scope: 'current',
        title: 'Second request',
      });

      const titles = updated.map((request) => request.title);
      expect(updated.length).toBe(2);
      expect(titles).toContain('First request');
      expect(titles).toContain('Second request');
    });
  });
});
