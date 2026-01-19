import { describe, expect, it } from 'bun:test';

import { matchesFilters } from './filters';
import type { RunRecord } from './types';

const baseRun: RunRecord = {
  runId: 'run-1',
  status: 'running',
  phase: 'implement',
  updatedAt: '2025-01-01T00:00:00.000Z',
  repoLabel: 'acme/web',
  taskProvider: 'github',
  taskTitle: 'Fix login bug',
  taskKey: 'GH-12',
  pr: { id: 'acme/web#12' },
};

describe('matchesFilters', () => {
  it('filters by status and phase', () => {
    expect(
      matchesFilters(baseRun, {
        query: '',
        status: ['running'],
        phase: ['implement'],
        convergence: [],
        provider: [],
        repo: [],
        task: [],
        pr: [],
      }),
    ).toBe(true);
    expect(
      matchesFilters(baseRun, {
        query: '',
        status: ['failed'],
        phase: ['implement'],
        convergence: [],
        provider: [],
        repo: [],
        task: [],
        pr: [],
      }),
    ).toBe(false);
  });

  it('filters by repo and provider', () => {
    expect(
      matchesFilters(baseRun, {
        query: '',
        status: [],
        phase: [],
        convergence: [],
        provider: ['github'],
        repo: ['acme'],
        task: [],
        pr: [],
      }),
    ).toBe(true);
  });

  it('filters by task and pr', () => {
    expect(
      matchesFilters(baseRun, {
        query: '',
        status: [],
        phase: [],
        convergence: [],
        provider: [],
        repo: [],
        task: ['login'],
        pr: ['#12'],
      }),
    ).toBe(true);
  });
});
