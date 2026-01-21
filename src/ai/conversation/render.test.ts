import { describe, expect, it } from 'bun:test';
import { appendMessages, createConversation } from 'conversationalist';

import { renderConversationSnapshot } from './render';

describe('renderConversationSnapshot', () => {
  it('renders a conversation snapshot as markdown', () => {
    const conversation = createConversation({ title: 'Test' });
    const updated = appendMessages(conversation, {
      role: 'user',
      content: 'Hello there',
    });
    const snapshot = {
      conversation: updated,
      digest: 'digest',
      updatedAt: new Date().toISOString(),
      path: 'memory',
    };
    const rendered = renderConversationSnapshot(snapshot);
    expect(rendered).toContain('Hello there');
    expect(rendered.endsWith('\n')).toBe(false);
  });
});
