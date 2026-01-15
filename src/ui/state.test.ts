import { describe, expect, it } from 'bun:test';

import type { Event } from '../events/schema';
import { applyDashboardEvent, createDashboardState } from './state';

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
  it('tracks run start and PR status', () => {
    let state = createDashboardState();
    state = applyDashboardEvent(state, baseEvent);

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
    expect(state.runs['run-1']?.pr?.ci).toBe('unknown');
  });
});
