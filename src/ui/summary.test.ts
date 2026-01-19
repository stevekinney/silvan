import { describe, expect, it } from 'bun:test';

import { buildRunSummary } from './summary';
import type { RunRecord } from './types';

describe('buildRunSummary', () => {
  it('counts status, phase, and convergence', () => {
    const runs: RunRecord[] = [
      {
        runId: 'run-1',
        status: 'running',
        phase: 'plan',
        updatedAt: '2025-01-01T00:00:00.000Z',
        convergence: {
          status: 'waiting_for_user',
          reasonCode: 'waiting_for_user',
          message: 'blocked',
          nextActions: [],
        },
      },
      {
        runId: 'run-2',
        status: 'success',
        phase: 'complete',
        updatedAt: '2025-01-01T01:00:00.000Z',
        convergence: {
          status: 'converged',
          reasonCode: 'converged',
          message: '',
          nextActions: [],
        },
      },
    ];

    const summary = buildRunSummary(runs);
    expect(summary.total).toBe(2);
    expect(summary.status.running).toBe(1);
    expect(summary.status.success).toBe(1);
    expect(summary.status.blocked).toBe(1);
    expect(summary.phase['plan']).toBe(1);
    expect(summary.phase['complete']).toBe(1);
    expect(summary.convergence['waiting_for_user']).toBe(1);
  });
});
