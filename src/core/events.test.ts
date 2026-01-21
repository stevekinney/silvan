import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { createEnvelope } from '../events/emit';
import { initStateStore } from '../state/store';
import { initEvents } from './events';

describe('initEvents', () => {
  it('suppresses renderer output in ui mode', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'silvan-ui-events-'));
    const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
    const events = initEvents(state, 'ui');

    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      await events.bus.emit(
        createEnvelope({
          type: 'log.message',
          source: 'cli',
          level: 'info',
          message: 'UI test message',
          context: { runId: 'ui-test', repoRoot },
          payload: { message: 'UI test message' },
        }),
      );
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(writes.join('')).toBe('');
  });
});
