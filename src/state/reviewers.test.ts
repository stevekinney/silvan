import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  readReviewerStats,
  recordReviewerRequests,
  recordReviewerResponses,
} from './reviewers';
import { initStateStore } from './store';

describe('reviewer stats', () => {
  it('records requests and responses', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'silvan-reviewers-'));
    const state = await initStateStore(repoRoot, { mode: 'repo', lock: false });

    await recordReviewerRequests({ state, reviewers: ['alice'] });
    await recordReviewerResponses({
      state,
      responses: [
        {
          reviewer: 'alice',
          responseHours: 1.5,
          respondedAt: new Date().toISOString(),
        },
      ],
    });

    const stats = await readReviewerStats(state);
    expect(stats.reviewers['alice']?.requested).toBe(1);
    expect(stats.reviewers['alice']?.responded).toBe(1);
    expect(stats.reviewers['alice']?.avgResponseHours).toBeCloseTo(1.5);

    await rm(repoRoot, { recursive: true, force: true });
  });
});
