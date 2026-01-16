import { conversationSchema, getMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import type { StateStore } from '../../state/store';
import { hashString } from '../../utils/hash';
import { renderConversationSnapshot } from './render';
import type { ConversationEnvelope, ConversationSnapshot } from './types';

type ConversationSummary = {
  runId: string;
  path: string;
  updatedAt: string;
  messageCount: number;
  summaryCount: number;
  lastMessages: Array<{ role: string; content: string }>;
};

type ShowOptions = {
  limit: number;
};

type ExportFormat = 'json' | 'md';

type ExportOptions = {
  format: ExportFormat;
};

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function getRunId(snapshot: ConversationSnapshot): string {
  const meta = snapshot.conversation.metadata;
  if (!meta || typeof meta !== 'object') return 'unknown';
  const value = meta['runId'];
  return typeof value === 'string' ? value : 'unknown';
}

export async function loadConversationSnapshot(
  state: StateStore,
  runId: string,
): Promise<ConversationSnapshot | null> {
  const envelope = await state.readRunState(runId);
  const data = (envelope?.data as Record<string, unknown>) ?? {};
  const meta = data['conversation'] as { path?: string; updatedAt?: string } | undefined;
  if (!meta?.path) return null;

  const text = await Bun.file(meta.path).text();
  const raw = JSON.parse(text) as ConversationEnvelope;
  const parsed = conversationSchema.safeParse(raw.conversation);
  if (!parsed.success) return null;

  return {
    conversation: parsed.data,
    digest: hashString(text),
    updatedAt: raw.updatedAt ?? meta.updatedAt ?? new Date().toISOString(),
    path: meta.path,
  };
}

export function summarizeConversationSnapshot(
  snapshot: ConversationSnapshot,
  options: ShowOptions,
): ConversationSummary {
  const messages = getMessages(snapshot.conversation);
  const last = messages.slice(-options.limit).map((message) => ({
    role: message.role,
    content: normalizeContent(message.content),
  }));
  const summaryCount = messages.filter((message) => {
    if (!message.metadata || typeof message.metadata !== 'object') return false;
    const meta = message.metadata as Record<string, unknown>;
    return meta['kind'] === 'summary';
  }).length;

  return {
    runId: getRunId(snapshot),
    path: snapshot.path,
    updatedAt: snapshot.updatedAt,
    messageCount: messages.length,
    summaryCount,
    lastMessages: last,
  };
}

export function renderConversationSummary(summary: ConversationSummary): string {
  const writer = new ProseWriter();
  writer.write(`Run: ${summary.runId}`);
  writer.write(`Path: ${summary.path}`);
  writer.write(`Updated: ${summary.updatedAt}`);
  writer.write(`Messages: ${summary.messageCount} (summaries: ${summary.summaryCount})`);
  writer.write('---');
  for (const entry of summary.lastMessages) {
    const trimmed =
      entry.content.length > 200 ? `${entry.content.slice(0, 200)}…` : entry.content;
    writer.write(`${entry.role}: ${trimmed}`);
  }
  return writer.toString().trimEnd();
}

export function exportConversationSnapshot(
  snapshot: ConversationSnapshot,
  options: ExportOptions,
): string {
  if (options.format === 'md') {
    return renderConversationSnapshot(snapshot);
  }
  const envelope: ConversationEnvelope = {
    version: '1.0.0',
    runId: getRunId(snapshot),
    updatedAt: snapshot.updatedAt,
    conversation: snapshot.conversation,
  };
  return JSON.stringify(envelope, null, 2);
}
