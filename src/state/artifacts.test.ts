import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { listArtifacts, writeArtifact } from './artifacts';
import { initStateStore } from './store';

describe('artifacts', () => {
  it('writes artifacts to the global artifacts directory and indexes them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'silvan-artifacts-'));
    const store = await initStateStore('/repo', { mode: 'global', root, lock: false });
    const runId = 'run-artifacts';

    const entry = await writeArtifact({
      state: store,
      runId,
      stepId: 'verify.run',
      name: 'report',
      data: { ok: true },
    });

    await store.writeRunState(runId, {
      artifactsIndex: {
        'verify.run': {
          report: entry,
        },
      },
    });

    const artifacts = await listArtifacts({ state: store, runId });
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]?.path).toContain('artifacts');

    await rm(root, { recursive: true, force: true });
  });
});
