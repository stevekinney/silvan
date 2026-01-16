import { toMarkdown } from 'conversationalist/markdown';

import type { ConversationSnapshot } from './types';

export function renderConversationSnapshot(snapshot: ConversationSnapshot): string {
  return toMarkdown(snapshot.conversation, { includeMetadata: false }).trimEnd();
}
