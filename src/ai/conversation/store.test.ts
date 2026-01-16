import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { configSchema } from '../../config/schema';
import { initStateStore } from '../../state/store';
import { createConversationStore } from './store';

describe('createConversationStore', () => {
  it('persists snapshots and updates run state', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'silvan-conv-'));
    const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
    const config = configSchema.parse({
      ai: {
        conversation: {
          pruning: {
            maxTurns: 1000,
            maxBytes: 1_000_000,
            summarizeAfterTurns: 1000,
            keepLastTurns: 20,
          },
        },
      },
    });
    const runId = 'run-123';
    const store = createConversationStore({ runId, state, config });

    const snapshot = await store.append({
      role: 'user',
      content: 'Hello world',
    });

    const envelope = await state.readRunState(runId);
    const data = (envelope?.data as Record<string, unknown>) ?? {};
    const conversationMeta = data['conversation'] as
      | { path?: string; digest?: string }
      | undefined;

    expect(snapshot.digest.length).toBeGreaterThan(0);
    expect(conversationMeta?.path).toBeTruthy();
    expect(conversationMeta?.digest).toBeTruthy();

    const file = await Bun.file(snapshot.path).text();
    expect(file).toContain('Hello world');

    await rm(repoRoot, { recursive: true, force: true });
  });
});
