import { describe, expect, it } from 'bun:test';
import { appendMessages, createConversation, getMessages } from 'conversationalist';

import { configSchema } from '../../config/schema';
import { optimizeConversation } from './optimize';
import { getConversationPruningPolicy } from './policy';

const stubSummarize = async () => 'summary text';

describe('optimizeConversation', () => {
  it('keeps priority messages and adds a summary', async () => {
    const config = configSchema.parse({
      ai: {
        conversation: {
          pruning: {
            maxTurns: 2,
            maxBytes: 1000,
            summarizeAfterTurns: 1,
            keepLastTurns: 1,
          },
          optimization: {
            enabled: true,
            retention: {
              system: 1,
              user: 1,
              assistant: 1,
              tool: 1,
              error: 1,
              correction: 1,
            },
            correctionPatterns: ['actually'],
          },
        },
      },
    });
    const policy = getConversationPruningPolicy(config);

    let conversation = createConversation({ title: 'test' });
    conversation = appendMessages(
      conversation,
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'ok' },
      { role: 'assistant', content: 'failure', metadata: { kind: 'error' } },
      { role: 'assistant', content: 'tool output', metadata: { kind: 'tool_result' } },
      { role: 'user', content: 'actually do X' },
      { role: 'assistant', content: 'final' },
    );

    const result = await optimizeConversation({
      conversation,
      policy,
      config,
      runId: 'run-1',
      force: true,
      summarize: stubSummarize,
    });

    const messages = getMessages(result.conversation);
    const contents = messages.map((message) => message.content);
    expect(result.metrics.summaryAdded).toBe(true);
    expect(contents).toContain('failure');
    expect(contents).toContain('tool output');
  });
});
