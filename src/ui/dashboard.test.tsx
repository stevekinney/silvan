import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';

import { EventBus } from '../events/bus';
import { initStateStore } from '../state/store';
import { Dashboard } from './dashboard';

async function withTempRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-ui-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('Dashboard', () => {
  test('renders empty state when no runs exist', async () => {
    await withTempRepo(async (repoRoot) => {
      const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
      const bus = new EventBus();
      const { lastFrame, unmount } = render(<Dashboard bus={bus} stateStore={state} />);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const frame = lastFrame() ?? '';
      expect(frame).toContain('No runs yet');
      unmount();
    });
  });

  test('renders runs loaded from disk', async () => {
    await withTempRepo(async (repoRoot) => {
      const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
      await state.writeRunState('run-1', {
        run: { status: 'running', phase: 'verify', updatedAt: new Date().toISOString() },
        summary: { ci: 'passing', unresolvedReviewCount: 2 },
      });
      const bus = new EventBus();
      const { lastFrame, unmount } = render(<Dashboard bus={bus} stateStore={state} />);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const frame = lastFrame() ?? '';
      expect(frame).toContain('run-1'.slice(0, 8));
      expect(frame).toContain('verify');
      unmount();
    });
  });
});
