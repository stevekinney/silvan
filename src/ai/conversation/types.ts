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
  optimization: ConversationOptimizationPolicy;
};

export type ConversationOptimizationRetention = {
  system: number;
  user: number;
  assistant: number;
  tool: number;
  error: number;
  correction: number;
};

export type ConversationOptimizationPolicy = {
  enabled: boolean;
  retention: ConversationOptimizationRetention;
  correctionPatterns: string[];
};

export type ConversationOptimizationMetrics = {
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
  compressionRatio: number;
  summaryAdded: boolean;
  changed: boolean;
};

export type ConversationOptimizationResult = {
  conversation: Conversation;
  snapshot?: ConversationSnapshot;
  metrics: ConversationOptimizationMetrics;
  backupPath?: string;
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
  | 'tool_result'
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
  optimize: (options?: { force?: boolean }) => Promise<ConversationOptimizationResult>;
};
