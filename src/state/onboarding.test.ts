import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  loadOnboardingState,
  markQuickstartCompleted,
  updateOnboardingState,
} from './onboarding';

async function createTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'silvan-onboarding-'));
}

describe('onboarding state', () => {
  it('returns empty state when no file exists', async () => {
    const root = await createTempRoot();
    const state = await loadOnboardingState({ root });
    expect(state).toEqual({});
  });

  it('persists updates and merges fields', async () => {
    const root = await createTempRoot();
    await updateOnboardingState(
      { firstRunCompleted: true, lastVersion: '0.1.0' },
      { root },
    );
    const state = await loadOnboardingState({ root });
    expect(state.firstRunCompleted).toBe(true);
    expect(state.lastVersion).toBe('0.1.0');
  });

  it('marks quickstart completion and first run', async () => {
    const root = await createTempRoot();
    const state = await markQuickstartCompleted('0.2.0', { root });
    expect(state.quickstartCompleted).toBe(true);
    expect(state.firstRunCompleted).toBe(true);
    expect(state.lastVersion).toBe('0.2.0');
  });
});
