import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import type { LearningNotes } from '../learning/notes';
import { listLearningRequests, writeLearningRequest } from './learning';
import { initStateStore } from './store';

describe('learning request queue', () => {
  it('writes and lists learning requests', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'silvan-learning-'));
    const state = await initStateStore(repoRoot, { mode: 'repo', lock: false });
    const notes: LearningNotes = {
      summary: 'Summary',
      rules: [],
      skills: [],
      docs: [],
    };

    await writeLearningRequest({
      state,
      request: {
        id: 'run-1',
        runId: 'run-1',
        status: 'pending',
        createdAt: new Date().toISOString(),
        summary: notes.summary,
        confidence: 0.4,
        threshold: 0.7,
        notes,
        targets: { docs: 'docs/learned.md' },
      },
    });

    const requests = await listLearningRequests({ state });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.runId).toBe('run-1');

    await rm(repoRoot, { recursive: true, force: true });
  });
});
