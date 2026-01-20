import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';

import { configSchema } from '../config/schema';
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

async function waitForFrame(
  getFrame: () => string,
  predicate: (frame: string) => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 500;
  const intervalMs = options?.intervalMs ?? 20;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = getFrame();
    if (predicate(frame)) return frame;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return getFrame();
}

describe('Dashboard', () => {
  test('renders empty state when no runs exist', async () => {
    await withTempRepo(async (repoRoot) => {
      const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
      const config = configSchema.parse({});
      const bus = new EventBus();
      const { lastFrame, unmount } = render(
        <Dashboard bus={bus} stateStore={state} config={config} />,
      );
      const frame = await waitForFrame(
        () => lastFrame() ?? '',
        (value) => value.includes('No runs yet'),
      );
      expect(frame).toContain('No runs yet');
      unmount();
    });
  });

  test('renders runs loaded from disk', async () => {
    await withTempRepo(async (repoRoot) => {
      const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
      const config = configSchema.parse({});
      await state.writeRunState('run-1', {
        run: { status: 'running', phase: 'verify', updatedAt: new Date().toISOString() },
        summary: { ci: 'passing', unresolvedReviewCount: 2 },
      });
      const bus = new EventBus();
      const { lastFrame, unmount } = render(
        <Dashboard bus={bus} stateStore={state} config={config} />,
      );
      const frame = await waitForFrame(
        () => lastFrame() ?? '',
        (value) => value.includes('run-1'.slice(0, 8)),
      );
      expect(frame).toContain('run-1'.slice(0, 8));
      expect(frame).toContain('verify');
      unmount();
    });
  });
});
