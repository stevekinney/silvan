import { describe, expect, it } from 'bun:test';
import { appendUserMessage, createConversation } from 'conversationalist';
import { z } from 'zod';

import { configSchema } from '../config/schema';
import type { ConversationSnapshot } from './conversation/types';
import { invokeCognition } from './router';

describe('invokeCognition', () => {
  it('routes cognition calls through the provided client', async () => {
    Bun.env['ANTHROPIC_API_KEY'] = 'test';
    const config = configSchema.parse({});
    let called = false;
    const client = {
      chat: async () => {
        called = true;
        return { content: { summary: 'ok' } };
      },
    };

    let conversation = createConversation({ title: 'test' });
    conversation = appendUserMessage(conversation, 'hello');
    const snapshot: ConversationSnapshot = {
      conversation,
      digest: 'digest',
      updatedAt: new Date().toISOString(),
      path: 'memory',
    };

    const schema = z.object({ summary: z.string() });
    const result = await invokeCognition({
      snapshot,
      task: 'conversationSummary',
      schema,
      config,
      client,
    });

    expect(called).toBe(true);
    expect(result.summary).toBe('ok');
  });
});
