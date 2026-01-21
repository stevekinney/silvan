import { describe, expect, it } from 'bun:test';
import { appendMessages, createConversation } from 'conversationalist';

import type { ConversationStore } from '../ai/conversation/types';
import { configSchema } from '../config/schema';
import { runAiReviewer } from './ai-reviewer';

function createMemoryStore(): ConversationStore {
  let conversation = createConversation({ title: 'Review' });
  const snapshot = async (value = conversation) => ({
    conversation: value,
    digest: 'digest',
    updatedAt: new Date().toISOString(),
    path: 'memory',
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
  };
}

describe('runAiReviewer', () => {
  it('returns a validated report', async () => {
    const config = configSchema.parse({});
    const report = await runAiReviewer({
      summary: {
        diffStat: '1 file changed',
        findings: [{ severity: 'warn', title: 'Note' }],
      },
      store: createMemoryStore(),
      config,
      invoke: (async () => ({
        shipIt: true,
        issues: [{ severity: 'info', note: 'Looks fine' }],
      })) as unknown as typeof import('../ai/router').invokeCognition,
    });
    expect(report.shipIt).toBe(true);
    expect(report.issues).toHaveLength(1);
  });

  it('throws when the report is invalid', async () => {
    const config = configSchema.parse({});
    return expect(
      runAiReviewer({
        summary: {
          diffStat: '1 file changed',
          findings: [],
        },
        store: createMemoryStore(),
        config,
        invoke: (async () => ({
          shipIt: 'nope',
          issues: [],
        })) as unknown as typeof import('../ai/router').invokeCognition,
      }),
    ).rejects.toThrow('AI reviewer validation failed');
  });
});
