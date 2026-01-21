import { describe, expect, it } from 'bun:test';

import { EventBus } from '../events/bus';
import { emitGitHubError } from './errors';

describe('emitGitHubError', () => {
  it('does nothing when no bus is provided', async () => {
    await emitGitHubError({
      context: { runId: 'run-1', repoRoot: '/tmp' },
      operation: 'find_pr',
      error: new Error('fail'),
    });
  });

  it('emits a structured error when bus is provided', async () => {
    const events: Array<{ type: string; payload: unknown; error?: unknown }> = [];
    const bus = new EventBus();
    const unsub = bus.subscribe((event) => {
      events.push(event as { type: string; payload: unknown; error?: unknown });
    });

    await emitGitHubError({
      bus,
      context: { runId: 'run-2', repoRoot: '/tmp', prId: 'acme/repo#2' },
      operation: 'fetch_checks',
      error: { status: 403, message: 'Forbidden' },
      pr: { owner: 'acme', repo: 'repo', number: 2 },
      details: 'Nope',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('github.error');
    expect(events[0]?.payload).toMatchObject({
      operation: 'fetch_checks',
      status: 403,
      details: 'Nope',
    });
    unsub();
  });
});
