import { describe, expect, it } from 'bun:test';

import type { Event } from '../events/schema';
import { applyDashboardEvent, applyRunSnapshots, createDashboardState } from './state';

const baseEvent = {
  schema: 'com.silvan.events',
  version: '1.0.0',
  id: 'evt',
  ts: new Date().toISOString(),
  level: 'info',
  source: 'cli',
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

describe('dashboard state reducer', () => {
  it('tracks run start, steps, and PR status', () => {
    let state = createDashboardState();
    state = applyDashboardEvent(state, baseEvent);

    const stepEvent: Event = {
      ...baseEvent,
      type: 'run.step',
      payload: {
        stepId: 'verify.run',
        title: 'Run verification',
        status: 'running',
      },
    };

    state = applyDashboardEvent(state, stepEvent);

    const prEvent: Event = {
      ...baseEvent,
      type: 'github.pr_opened_or_updated',
      payload: {
        pr: { owner: 'a', repo: 'b', number: 1, url: 'http://pr' },
        action: 'opened',
        headBranch: 'feature/test',
        baseBranch: 'main',
        title: 'feature/test',
      },
    };

    state = applyDashboardEvent(state, prEvent);

    expect(state.runs['run-1']?.pr?.id).toBe('a/b#1');
    expect(state.runs['run-1']?.step?.stepId).toBe('verify.run');
  });

  it('records run completion', () => {
    let state = createDashboardState();
    state = applyDashboardEvent(state, baseEvent);

    const finishedEvent: Event = {
      ...baseEvent,
      type: 'run.finished',
      payload: {
        status: 'success',
        durationMs: 1000,
      },
    };

    state = applyDashboardEvent(state, finishedEvent);
    expect(state.runs['run-1']?.status).toBe('success');
  });

  it('hydrates run state from disk snapshots', () => {
    const snapshotState = applyRunSnapshots(createDashboardState(), [
      {
        runId: 'run-2',
        repoId: 'repo-1',
        repoLabel: 'repo-1',
        path: '/tmp/run-2.json',
        updatedAt: new Date().toISOString(),
        data: {
          run: {
            status: 'running',
            phase: 'verify',
            updatedAt: new Date().toISOString(),
          },
          summary: { ci: 'passing', unresolvedReviewCount: 1 },
        },
      },
    ]);

    expect(snapshotState.runs['run-2']?.phase).toBe('verify');
    expect(snapshotState.runs['run-2']?.review?.unresolvedCount).toBe(1);
  });

  it('flags stale leases as stuck', () => {
    const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const snapshotState = applyRunSnapshots(createDashboardState(), [
      {
        runId: 'run-3',
        repoId: 'repo-1',
        repoLabel: 'repo-1',
        path: '/tmp/run-3.json',
        updatedAt: new Date().toISOString(),
        data: {
          run: {
            status: 'running',
            phase: 'verify',
            step: 'ci.wait.review',
            updatedAt: new Date().toISOString(),
          },
          steps: {
            'ci.wait.review': {
              status: 'running',
              lease: { heartbeatAt: past, startedAt: past },
            },
          },
        },
      },
    ]);

    expect(snapshotState.runs['run-3']?.stuck?.reason).toBe('lease stale');
  });
});
