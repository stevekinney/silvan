import { describe, expect, it } from 'bun:test';

import type { Event } from '../events/schema';
import { buildPhaseTimeline, buildStepHistory } from './history';
import type { RunRecord, RunStepSummary } from './types';

const baseEvent = {
  schema: 'com.silvan.events',
  version: '1.0.0',
  id: 'evt',
  ts: '2025-01-01T00:00:00.000Z',
  level: 'info',
  source: 'engine',
  runId: 'run-1',
  repoId: 'repo-1',
  type: 'run.started',
  payload: {
    runId: 'run-1',
    command: 'silvan',
    args: [],
    cwd: '/tmp',
    repoRoot: '/tmp',
  },
} satisfies Event;

describe('buildPhaseTimeline', () => {
  it('orders phases and computes durations', () => {
    const events: Event[] = [
      {
        ...baseEvent,
        ts: '2025-01-01T00:01:00.000Z',
        type: 'run.phase_changed',
        payload: { from: 'idle', to: 'worktree' },
      },
      {
        ...baseEvent,
        ts: '2025-01-01T00:02:00.000Z',
        type: 'run.phase_changed',
        payload: { from: 'worktree', to: 'plan' },
      },
      {
        ...baseEvent,
        ts: '2025-01-01T00:05:00.000Z',
        type: 'run.phase_changed',
        payload: { from: 'plan', to: 'implement' },
      },
    ];
    const run: RunRecord = {
      runId: 'run-1',
      status: 'running',
      phase: 'implement',
      updatedAt: '2025-01-01T00:10:00.000Z',
      startedAt: '2025-01-01T00:00:00.000Z',
    };
    const timeline = buildPhaseTimeline(
      events,
      run,
      Date.parse('2025-01-01T00:10:00.000Z'),
    );
    const plan = timeline.find((entry) => entry.phase === 'plan');
    const implement = timeline.find((entry) => entry.phase === 'implement');
    expect(plan?.status).toBe('completed');
    expect(plan?.durationMs).toBe(3 * 60 * 1000);
    expect(implement?.status).toBe('running');
    expect(implement?.durationMs).toBe(5 * 60 * 1000);
  });
});

describe('buildStepHistory', () => {
  it('builds step durations and errors', () => {
    const events: Event[] = [
      {
        ...baseEvent,
        ts: '2025-01-01T00:01:00.000Z',
        type: 'run.step',
        payload: { stepId: 'plan.generate', title: 'Generate plan', status: 'running' },
      },
      {
        ...baseEvent,
        ts: '2025-01-01T00:02:00.000Z',
        type: 'run.step',
        payload: { stepId: 'plan.generate', title: 'Generate plan', status: 'succeeded' },
      },
    ];
    const steps: RunStepSummary[] = [
      {
        stepId: 'verify.run',
        status: 'failed',
        startedAt: '2025-01-01T00:03:00.000Z',
        endedAt: '2025-01-01T00:04:00.000Z',
        error: 'Lint failed',
      },
    ];
    const history = buildStepHistory(
      steps,
      events,
      Date.parse('2025-01-01T00:05:00.000Z'),
    );
    const plan = history.find((entry) => entry.stepId === 'plan.generate');
    const verify = history.find((entry) => entry.stepId === 'verify.run');
    expect(plan?.status).toBe('completed');
    expect(plan?.durationMs).toBe(60 * 1000);
    expect(verify?.status).toBe('failed');
    expect(verify?.error).toBe('Lint failed');
  });
});
