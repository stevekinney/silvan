import {
  appendMessages,
  appendSystemMessage,
  type Conversation,
  createConversation,
  getMessages,
  type Message,
  type MessageInput,
} from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import { hashString } from '../../utils/hash';
import { summarizeConversation } from '../cognition/summarize';
import type {
  ConversationOptimizationMetrics,
  ConversationOptimizationResult,
  ConversationOptimizationRetention,
  ConversationPruningPolicy,
  ConversationSnapshot,
} from './types';

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateTokensForMessages(messages: Message[]): number {
  return messages.reduce(
    (sum, message) => sum + estimateTokens(normalizeContent(message.content)),
    0,
  );
}

function isExplicitlyProtected(message: Message): boolean {
  const metadata = message.metadata as { protected?: boolean } | undefined;
  return Boolean(metadata?.protected);
}

function buildSummaryPrompt(): string {
  const writer = new ProseWriter();
  writer.write('Summarize the conversation context into a compact, factual summary.');
  writer.write('Preserve key decisions, constraints, errors, and unresolved items.');
  writer.write('Include user corrections and tool outcomes when relevant.');
  writer.write('Return JSON only with: { summary: string }.');
  return writer.toString().trimEnd();
}

function buildSummarySnapshot(
  conversation: Conversation,
  runId: string,
): ConversationSnapshot {
  const payload = JSON.stringify(conversation);
  return {
    conversation,
    digest: hashString(payload),
    updatedAt: new Date().toISOString(),
    path: `memory:${runId}`,
  };
}

function compileCorrectionPatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, 'i'));
    } catch {
      continue;
    }
  }
  return compiled;
}

function isCorrectionMessage(message: Message, patterns: RegExp[]): boolean {
  if (message.role !== 'user') return false;
  if (patterns.length === 0) return false;
  const content = normalizeContent(message.content);
  return patterns.some((pattern) => pattern.test(content));
}

function isErrorMessage(message: Message): boolean {
  const metadata = message.metadata as { kind?: string } | undefined;
  if (metadata?.kind === 'error') return true;
  if (message.toolResult?.outcome === 'error') return true;
  if (metadata?.kind !== 'tool_result' && message.role !== 'tool-result') return false;
  const content = normalizeContent(message.content).toLowerCase();
  return content.includes('error') || content.includes('exception');
}

function isToolMessage(message: Message): boolean {
  const metadata = message.metadata as { kind?: string } | undefined;
  return (
    message.role === 'tool-use' ||
    message.role === 'tool-result' ||
    metadata?.kind === 'tool_result'
  );
}

function normalizeRetention(
  retention: ConversationOptimizationRetention,
): ConversationOptimizationRetention {
  return {
    system: retention.system,
    user: retention.user,
    assistant: retention.assistant,
    tool: retention.tool,
    error: retention.error,
    correction: retention.correction,
  };
}

function normalizeRole(message: Message): 'system' | 'user' | 'assistant' | 'tool' {
  if (isToolMessage(message)) return 'tool';
  if (
    message.role === 'system' ||
    message.role === 'user' ||
    message.role === 'assistant'
  ) {
    return message.role;
  }
  return 'assistant';
}

function selectRetentionIds(
  messages: Message[],
  retention: ConversationOptimizationRetention,
  keepLastTurns: number,
  correctionPatterns: RegExp[],
): Set<string> {
  const keepIds = new Set<string>();
  for (const message of messages) {
    if (isExplicitlyProtected(message)) {
      keepIds.add(message.id);
    }
  }

  const tail = messages.slice(-keepLastTurns);
  for (const message of tail) {
    keepIds.add(message.id);
  }

  const counts: Record<'system' | 'user' | 'assistant' | 'tool', number> = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
  };
  const errorRetention = retention.error;
  const correctionRetention = retention.correction;
  let errorCount = 0;
  let correctionCount = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const role = normalizeRole(message);
    if (counts[role] < retention[role]) {
      keepIds.add(message.id);
      counts[role] += 1;
    }

    if (errorCount < errorRetention && isErrorMessage(message)) {
      keepIds.add(message.id);
      errorCount += 1;
    }
    if (
      correctionCount < correctionRetention &&
      isCorrectionMessage(message, correctionPatterns)
    ) {
      keepIds.add(message.id);
      correctionCount += 1;
    }
  }

  return keepIds;
}

function buildOptimizationMetrics(
  beforeMessages: Message[],
  afterMessages: Message[],
  summaryAdded: boolean,
): ConversationOptimizationMetrics {
  const beforeTokens = estimateTokensForMessages(beforeMessages);
  const afterTokens = estimateTokensForMessages(afterMessages);
  const tokensSaved = Math.max(0, beforeTokens - afterTokens);
  const compressionRatio = beforeTokens === 0 ? 1 : afterTokens / beforeTokens;
  return {
    beforeMessages: beforeMessages.length,
    afterMessages: afterMessages.length,
    beforeTokens,
    afterTokens,
    tokensSaved,
    compressionRatio,
    summaryAdded,
    changed: beforeMessages.length !== afterMessages.length || summaryAdded,
  };
}

function toMessageInput(message: Message): MessageInput {
  const content: MessageInput['content'] =
    typeof message.content === 'string' ? message.content : Array.from(message.content);
  return {
    role: message.role,
    content,
    ...(message.metadata ? { metadata: message.metadata } : {}),
  };
}

export async function optimizeConversation(options: {
  conversation: Conversation;
  policy: ConversationPruningPolicy;
  config: Config;
  runId: string;
  force?: boolean;
  summarize?: typeof summarizeConversation;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<ConversationOptimizationResult> {
  const messages = getMessages(options.conversation);
  const retention = normalizeRetention(options.policy.optimization.retention);
  const correctionPatterns = compileCorrectionPatterns(
    options.policy.optimization.correctionPatterns,
  );
  const keepIds = selectRetentionIds(
    messages,
    retention,
    options.policy.keepLastTurns,
    correctionPatterns,
  );

  const candidates = messages.filter((message) => !keepIds.has(message.id));
  let summaryAdded = false;
  let next = options.conversation;

  const shouldSummarize =
    options.force || messages.length > options.policy.summarizeAfterTurns;
  if (candidates.length > 0 && shouldSummarize) {
    let summaryConversation = createConversation({
      title: `silvan:${options.runId}:optimize`,
      metadata: options.conversation.metadata,
    });
    const prompt = buildSummaryPrompt();
    const candidateInputs = candidates.map(toMessageInput);
    summaryConversation = appendMessages(summaryConversation, ...candidateInputs);
    summaryConversation = appendMessages(summaryConversation, {
      role: 'user',
      content: prompt,
      metadata: { kind: 'summary' },
    });

    const snapshot = buildSummarySnapshot(summaryConversation, options.runId);
    const summarize = options.summarize ?? summarizeConversation;
    const summary = await summarize({
      snapshot,
      config: options.config,
      ...(options.bus ? { bus: options.bus } : {}),
      ...(options.context ? { context: options.context } : {}),
    });
    next = appendSystemMessage(next, summary, {
      metadata: { kind: 'summary', protected: true },
    });
    const nextMessages = getMessages(next);
    const summaryMessage = nextMessages[nextMessages.length - 1];
    if (summaryMessage) {
      keepIds.add(summaryMessage.id);
      summaryAdded = true;
    }
  }

  const nextMessages = getMessages(next);
  const finalIds = nextMessages
    .filter((message) => keepIds.has(message.id))
    .map((message) => message.id);
  const finalMessages: Record<string, Message> = {};
  for (const message of nextMessages) {
    if (keepIds.has(message.id)) {
      finalMessages[message.id] = message;
    }
  }

  const finalList = finalIds
    .map((id) => finalMessages[id])
    .filter((message): message is Message => Boolean(message));
  const metrics = buildOptimizationMetrics(messages, finalList, summaryAdded);

  const optimized: Conversation = {
    ...next,
    ids: finalIds,
    messages: finalMessages,
    metadata: {
      ...(next.metadata ?? {}),
      optimization: {
        updatedAt: new Date().toISOString(),
        ...metrics,
      },
    },
  };

  return { conversation: optimized, metrics };
}
