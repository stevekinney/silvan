import { access, copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  appendMessages,
  appendSystemMessage,
  type Conversation,
  conversationSchema,
  createConversation,
  getMessageIds,
  getMessages,
  type Message,
  type MessageInput,
} from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import { createEnvelope } from '../../events/emit';
import type { StateStore } from '../../state/store';
import { hashString } from '../../utils/hash';
import { summarizeConversation } from '../cognition/summarize';
import { optimizeConversation } from './optimize';
import { getConversationPruningPolicy } from './policy';
import type {
  ConversationEnvelope,
  ConversationMessageMetadata,
  ConversationOptimizationResult,
  ConversationPruningPolicy,
  ConversationSnapshot,
  ConversationStore,
} from './types';

const conversationVersion = '1.0.0';

type StoreOptions = {
  runId: string;
  state: StateStore;
  config: Config;
  bus?: EventBus;
  context?: EmitContext;
};

function isProtectedMessage(message: Message): boolean {
  const metadata = message.metadata as ConversationMessageMetadata | undefined;
  return Boolean(metadata?.protected);
}

function shouldSummarize(turnCount: number, summarizeAfterTurns: number): boolean {
  return turnCount > summarizeAfterTurns;
}

function shouldPrune(
  turnCount: number,
  bytes: number,
  policy: ConversationPruningPolicy,
): boolean {
  return turnCount > policy.maxTurns || bytes > policy.maxBytes;
}

async function emitConversationStep(
  bus: EventBus | undefined,
  context: EmitContext | undefined,
  stepId: string,
  title: string,
): Promise<void> {
  if (!bus || !context) return;
  await bus.emit(
    createEnvelope({
      type: 'run.step',
      source: 'ai',
      level: 'info',
      context,
      payload: {
        stepId,
        title,
        status: 'succeeded' as const,
      },
    }),
  );
}

export function createConversationStore(options: StoreOptions): ConversationStore {
  const conversationPath = join(options.state.conversationsDir, `${options.runId}.json`);
  const policy = getConversationPruningPolicy(options.config);

  async function load(): Promise<Conversation> {
    try {
      const raw = JSON.parse(
        await Bun.file(conversationPath).text(),
      ) as ConversationEnvelope;
      if (raw?.version && raw?.conversation) {
        const parsed = conversationSchema.safeParse(raw.conversation);
        if (parsed.success) {
          return parsed.data;
        }
      }
    } catch {
      // ignore
    }
    return createConversation({
      title: `silvan:${options.runId}`,
      metadata: { runId: options.runId, repoId: options.state.repoId },
    });
  }

  async function writeConversation(
    conversation: Conversation,
  ): Promise<ConversationSnapshot> {
    const updatedAt = new Date().toISOString();
    const envelope: ConversationEnvelope = {
      version: conversationVersion,
      runId: options.runId,
      updatedAt,
      conversation,
    };
    const payload = JSON.stringify(envelope, null, 2);
    await mkdir(dirname(conversationPath), { recursive: true });
    const temp = join(
      dirname(conversationPath),
      `${options.runId}.${crypto.randomUUID()}.tmp`,
    );
    await writeFile(temp, payload, 'utf8');
    await rename(temp, conversationPath);

    const digest = hashString(payload);
    await options.state.updateRunState(options.runId, (data) => ({
      ...data,
      conversation: {
        path: conversationPath,
        digest,
        updatedAt,
        version: conversationVersion,
      },
    }));

    await emitConversationStep(
      options.bus,
      options.context,
      'ai.conversation.snapshot',
      'Conversation snapshot saved',
    );

    return {
      conversation,
      digest,
      updatedAt,
      path: conversationPath,
    };
  }

  async function backupConversation(): Promise<string | undefined> {
    try {
      await access(conversationPath);
    } catch {
      return undefined;
    }
    const backupPath = join(
      dirname(conversationPath),
      `${options.runId}.backup.${Date.now()}.json`,
    );
    await copyFile(conversationPath, backupPath);
    return backupPath;
  }

  async function recordOptimization(
    metrics: { [key: string]: unknown },
    backupPath?: string,
  ): Promise<void> {
    await options.state.updateRunState(options.runId, (data) => ({
      ...data,
      conversationOptimization: {
        updatedAt: new Date().toISOString(),
        ...(backupPath ? { backupPath } : {}),
        ...metrics,
      },
    }));
  }

  async function prune(conversation: Conversation): Promise<Conversation> {
    const ids = getMessageIds(conversation);
    const payload = JSON.stringify(conversation);
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (!shouldPrune(ids.length, bytes, policy)) {
      return conversation;
    }

    if (policy.optimization.enabled) {
      const result = await optimizeConversation({
        conversation,
        policy,
        config: options.config,
        runId: options.runId,
        ...(options.bus ? { bus: options.bus } : {}),
        ...(options.context ? { context: options.context } : {}),
      });

      let backupPath: string | undefined;
      if (result.metrics.changed) {
        backupPath = await backupConversation();
        await recordOptimization(result.metrics, backupPath);
      }

      await emitConversationStep(
        options.bus,
        options.context,
        'ai.conversation.optimized',
        result.metrics.changed ? 'Conversation optimized' : 'Conversation checked',
      );

      return result.conversation;
    }

    let next = conversation;
    if (shouldSummarize(ids.length, policy.summarizeAfterTurns)) {
      const summaryWriter = new ProseWriter();
      summaryWriter.write(
        'Summarize the conversation so far into a compact, factual summary.',
      );
      summaryWriter.write('Return JSON only with: { summary: string }.');
      const summaryRequest = summaryWriter.toString().trimEnd();

      const requested = appendMessages(next, {
        role: 'user',
        content: summaryRequest,
        metadata: { kind: 'summary' },
      });

      const snapshot = await writeConversation(requested);
      const summary = await summarizeConversation({
        snapshot,
        config: options.config,
        ...(options.bus ? { bus: options.bus } : {}),
        ...(options.context ? { context: options.context } : {}),
      });
      next = appendSystemMessage(requested, summary, {
        metadata: { kind: 'summary', protected: true },
      });
    }

    const messages = getMessages(next);
    const keepIds = new Set(
      messages.slice(-policy.keepLastTurns).map((message) => message.id),
    );
    const protectedIds = new Set(
      messages
        .filter((message) => isProtectedMessage(message) || message.role === 'system')
        .map((message) => message.id),
    );
    const finalIds = messages
      .filter((message) => keepIds.has(message.id) || protectedIds.has(message.id))
      .map((message) => message.id);
    const finalMessages: Record<string, Message> = {};
    for (const message of messages) {
      if (finalIds.includes(message.id)) {
        finalMessages[message.id] = message;
      }
    }
    next = {
      ...next,
      ids: finalIds,
      messages: finalMessages,
    };

    await emitConversationStep(
      options.bus,
      options.context,
      'ai.conversation.pruned',
      'Conversation pruned',
    );

    return next;
  }

  async function save(
    conversation: Conversation,
    options?: { prune?: boolean },
  ): Promise<ConversationSnapshot> {
    const next = options?.prune === false ? conversation : await prune(conversation);
    return writeConversation(next);
  }

  async function append(
    messages: MessageInput | MessageInput[],
    options?: { prune?: boolean },
  ): Promise<ConversationSnapshot> {
    const current = await load();
    const next = Array.isArray(messages)
      ? appendMessages(current, ...messages)
      : appendMessages(current, messages);
    return save(next, options);
  }

  async function snapshot(conversation?: Conversation): Promise<ConversationSnapshot> {
    const current = conversation ?? (await load());
    return writeConversation(current);
  }

  async function optimize(opt?: {
    force?: boolean;
  }): Promise<ConversationOptimizationResult> {
    const current = await load();
    const result = await optimizeConversation({
      conversation: current,
      policy,
      config: options.config,
      runId: options.runId,
      force: opt?.force ?? false,
      ...(options.bus ? { bus: options.bus } : {}),
      ...(options.context ? { context: options.context } : {}),
    });

    let backupPath: string | undefined;
    if (result.metrics.changed) {
      backupPath = await backupConversation();
      await recordOptimization(result.metrics, backupPath);
    }

    await emitConversationStep(
      options.bus,
      options.context,
      'ai.conversation.optimized',
      result.metrics.changed ? 'Conversation optimized' : 'Conversation checked',
    );

    const snapshot = await writeConversation(result.conversation);
    return {
      conversation: result.conversation,
      snapshot,
      metrics: result.metrics,
      ...(backupPath ? { backupPath } : {}),
    };
  }

  return {
    load,
    save,
    append,
    snapshot,
    optimize,
  };
}
