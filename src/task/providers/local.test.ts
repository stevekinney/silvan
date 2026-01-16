import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { initStateStore } from '../../state/store';
import { createLocalTask, loadLocalTask } from './local';

describe('local task provider', () => {
  it('creates and loads a local task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'silvan-local-task-'));
    const state = await initStateStore('/repo', { mode: 'global', root, lock: false });
    const task = await createLocalTask({
      state,
      input: {
        title: 'Add fuzzy search',
        description: 'Support fuzzy searching in the list view.',
        acceptanceCriteria: ['Search matches partial strings'],
      },
    });

    const loaded = await loadLocalTask(state, task.id);
    expect(loaded.title).toBe('Add fuzzy search');
    expect(loaded.provider).toBe('local');
    expect(loaded.key).toBeDefined();

    await rm(root, { recursive: true, force: true });
  });
});
