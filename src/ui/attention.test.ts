import { describe, expect, it } from 'bun:test';

import { needsAttention } from './attention';
import type { RunRecord } from './types';

const now = Date.parse('2025-01-01T01:00:00.000Z');

describe('needsAttention', () => {
  it('flags failed runs immediately', () => {
    const run: RunRecord = {
      runId: 'run-1',
      status: 'failed',
      phase: 'verify',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    expect(needsAttention(run, now)).toBe(true);
  });

  it('flags blocked convergence', () => {
    const run: RunRecord = {
      runId: 'run-2',
      status: 'running',
      phase: 'review',
      updatedAt: '2025-01-01T00:00:00.000Z',
      convergence: {
        status: 'blocked',
        reasonCode: 'blocked',
        message: 'Awaiting approval',
        nextActions: [],
      },
    };
    expect(needsAttention(run, now)).toBe(true);
  });

  it('flags long-waiting CI', () => {
    const run: RunRecord = {
      runId: 'run-3',
      status: 'running',
      phase: 'ci',
      updatedAt: '2025-01-01T00:00:00.000Z',
      latestEventAt: '2025-01-01T00:00:00.000Z',
      convergence: {
        status: 'waiting_for_ci',
        reasonCode: 'waiting_for_ci',
        message: 'CI pending',
        nextActions: [],
      },
    };
    expect(needsAttention(run, now)).toBe(true);
  });
});
