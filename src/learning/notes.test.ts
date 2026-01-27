import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import { appendMessages, createConversation } from 'conversationalist';

import type { ConversationStore } from '../ai/conversation/types';
import { configSchema } from '../config/schema';
import {
  applyLearningNotes,
  generateLearningNotes,
  renderLearningMarkdown,
} from './notes';

function createMemoryStore(): ConversationStore {
  let conversation = createConversation({ title: 'Learning' });
  const snapshot = async (value = conversation) => ({
    conversation: value,
    digest: 'digest',
    updatedAt: new Date().toISOString(),
    path: 'memory',
  });
  const metrics = () => ({
    beforeMessages: conversation.ids.length,
    afterMessages: conversation.ids.length,
    beforeTokens: 0,
    afterTokens: 0,
    tokensSaved: 0,
    compressionRatio: 1,
    summaryAdded: false,
    changed: false,
  });
  return {
    load: async () => conversation,
    save: async (next) => {
      conversation = next;
      return snapshot(conversation);
    },
    append: async (messages) => {
      const list = Array.isArray(messages) ? messages : [messages];
      conversation = appendMessages(conversation, ...list);
      return snapshot(conversation);
    },
    snapshot,
    optimize: async () => {
      const snap = await snapshot();
      return { conversation: snap.conversation, snapshot: snap, metrics: metrics() };
    },
  };
}

describe('generateLearningNotes', () => {
  it('returns deterministic notes when AI learning is disabled', async () => {
    const config = configSchema.parse({
      learning: { ai: { enabled: false } },
    });
    const notes = await generateLearningNotes({
      input: { diffStat: '1 file changed', verification: { ok: false } },
      store: createMemoryStore(),
      config,
    });
    expect(notes.summary).toContain('Changes: 1 file changed');
    expect(notes.docs.length).toBeGreaterThan(0);
  });

  it('returns model notes when AI learning is enabled', async () => {
    const config = configSchema.parse({
      learning: { ai: { enabled: true } },
    });
    const notes = await generateLearningNotes({
      input: { diffStat: '1 file changed' },
      store: createMemoryStore(),
      config,
      invoke: (async () => ({
        summary: 'Summary',
        rules: ['Rule'],
        skills: [],
        docs: [],
      })) as unknown as typeof import('../ai/router').invokeCognition,
    });
    expect(notes.summary).toBe('Summary');
  });
});

describe('renderLearningMarkdown', () => {
  it('renders a markdown report', () => {
    const output = renderLearningMarkdown(
      'run-1',
      { task: { key: 'ENG-1', title: 'Work' } },
      { summary: 'Done', rules: ['Rule'], skills: [], docs: [] },
    );
    expect(output).toContain('# Learning notes (run-1)');
    expect(output).toContain('Rule');
  });
});

describe('applyLearningNotes', () => {
  it('appends learning notes to targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'silvan-learning-'));
    try {
      const result = await applyLearningNotes({
        runId: 'run-2',
        worktreeRoot: dir,
        notes: { summary: 'Summary', rules: ['Rule'], skills: [], docs: [] },
        targets: { rules: 'docs/rules.md' },
      });
      expect(result.appliedTo).toHaveLength(1);
      const content = await readFile(result.appliedTo[0]!, 'utf8');
      expect(content).toContain('Rule');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
