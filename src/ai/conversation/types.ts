import type { Conversation, MessageInput } from 'conversationalist';

export type ConversationEnvelope = {
  version: '1.0.0';
  runId: string;
  updatedAt: string;
  conversation: Conversation;
};

export type ConversationSnapshot = {
  conversation: Conversation;
  digest: string;
  updatedAt: string;
  path: string;
};

export type ConversationPruningPolicy = {
  maxTurns: number;
  maxBytes: number;
  summarizeAfterTurns: number;
  keepLastTurns: number;
};

export type ConversationMessageKind =
  | 'task'
  | 'plan'
  | 'kickoff'
  | 'review'
  | 'ci'
  | 'verification'
  | 'recovery'
  | 'pr'
  | 'learning'
  | 'error'
  | 'summary';

export type ConversationMessageMetadata = {
  kind?: ConversationMessageKind;
  protected?: boolean;
};

export type ConversationStore = {
  load: () => Promise<Conversation>;
  save: (
    conversation: Conversation,
    options?: { prune?: boolean },
  ) => Promise<ConversationSnapshot>;
  append: (
    messages: MessageInput | MessageInput[],
    options?: { prune?: boolean },
  ) => Promise<ConversationSnapshot>;
  snapshot: (conversation?: Conversation) => Promise<ConversationSnapshot>;
};
