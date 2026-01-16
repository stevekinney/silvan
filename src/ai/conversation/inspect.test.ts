import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { configSchema } from '../../config/schema';
import { initStateStore } from '../../state/store';
import {
  exportConversationSnapshot,
  loadConversationSnapshot,
  renderConversationSummary,
  summarizeConversationSnapshot,
} from './inspect';
import { createConversationStore } from './store';

describe('conversation inspection', () => {
  it('loads and renders a conversation summary', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'silvan-convo-'));
    const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
    const config = configSchema.parse({});
    const runId = 'run-convo';
    const store = createConversationStore({ runId, state, config });

    await store.append({ role: 'user', content: 'Hello from convo' });
    const snapshot = await loadConversationSnapshot(state, runId);
    expect(snapshot).not.toBeNull();

    const summary = summarizeConversationSnapshot(snapshot!, { limit: 5 });
    const text = renderConversationSummary(summary);
    expect(text).toContain('Hello from convo');

    const exported = exportConversationSnapshot(snapshot!, { format: 'json' });
    expect(exported).toContain('Hello from convo');

    await rm(repoRoot, { recursive: true, force: true });
  });
});
