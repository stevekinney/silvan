import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { createLLM } from '@lasercat/homogenaize';
import { toChatMessages } from 'conversationalist';
import type { ZodSchema } from 'zod';

import type { ClaudeRunOptions } from '../agent/sdk';
import { runClaudePrompt } from '../agent/sdk';
import type { Config } from '../config/schema';
import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { readAiCache, writeAiCache } from './cache';
import { getCognitionModel, resolveCognitionProvider } from './cognition/policy';
import { renderConversationSnapshot } from './conversation';
import type { ConversationSnapshot } from './conversation/types';

export type CognitionTask =
  | 'initDefaults'
  | 'kickoffPrompt'
  | 'plan'
  | 'reviewClassify'
  | 'reviewCluster'
  | 'localReview'
  | 'reviewKickoff'
  | 'ciTriage'
  | 'verificationSummary'
  | 'verificationFix'
  | 'recovery'
  | 'prDraft'
  | 'conversationSummary'
  | 'learningNotes';

export type AiInvocation =
  | {
      kind: CognitionTask;
      needsTools: false;
      snapshot: ConversationSnapshot;
    }
  | {
      kind: 'execute';
      needsTools: true;
      snapshot: ConversationSnapshot;
    };

type CognitionOptions<T> = {
  snapshot: ConversationSnapshot;
  task: CognitionTask;
  schema: ZodSchema<T>;
  config: Config;
  inputsDigest?: string;
  cacheDir?: string;
  client?: {
    chat: (options: {
      messages: unknown;
      schema: ZodSchema<T>;
    }) => Promise<{ content: T }>;
  };
  bus?: EventBus;
  context?: EmitContext;
  temperature?: number;
};

type AgentOptions = Omit<ClaudeRunOptions, 'message'> & {
  snapshot: ConversationSnapshot;
  bus?: EventBus;
  context?: EmitContext;
};

async function emitSnapshotConsumed(
  bus: EventBus | undefined,
  context: EmitContext | undefined,
  digest: string,
  title: string,
): Promise<void> {
  if (!bus || !context) return;
  await bus.emit(
    createEnvelope({
      type: 'run.step',
      source: 'ai',
      level: 'info',
      context,
      message: `snapshot:${digest}`,
      payload: {
        stepId: 'ai.conversation.consumed',
        title,
        status: 'succeeded' as const,
      },
    }),
  );
}

export async function invokeCognition<T>(options: CognitionOptions<T>): Promise<T> {
  const provider = resolveCognitionProvider(options.config);
  const model = getCognitionModel(options.config, options.task);
  const apiKey = provider.apiKey;
  const client =
    options.client ??
    createLLM({
      provider: provider.provider,
      apiKey,
      model: model as Parameters<typeof createLLM>[0]['model'],
    });

  const messages = toChatMessages(options.snapshot.conversation);
  await emitSnapshotConsumed(
    options.bus,
    options.context,
    options.snapshot.digest,
    `Cognition snapshot consumed (${options.task})`,
  );

  const cacheEnabled = options.config.ai?.cache?.enabled ?? true;
  if (cacheEnabled && options.inputsDigest && options.cacheDir) {
    const cached = await readAiCache({
      cacheDir: options.cacheDir,
      key: {
        promptKind: options.task,
        inputsDigest: options.inputsDigest,
        provider: provider.provider,
        model,
      },
      schema: options.schema,
    });
    if (cached !== null) {
      if (options.bus && options.context) {
        await options.bus.emit(
          createEnvelope({
            type: 'run.step',
            source: 'ai',
            level: 'info',
            context: options.context,
            message: `cache:${options.task}`,
            payload: {
              stepId: 'ai.cache.hit',
              title: `AI cache hit (${options.task})`,
              status: 'succeeded' as const,
            },
          }),
        );
      }
      return cached;
    }
  }

  const start = performance.now();
  if (options.bus && options.context) {
    await options.bus.emit(
      createEnvelope({
        type: 'ai.session_started',
        source: 'ai',
        level: 'info',
        context: options.context,
        message: `snapshot:${options.snapshot.digest}`,
        payload: {
          model: { provider: provider.provider, model },
          task: options.task,
        },
      }),
    );
  }

  let response: { content: T } | undefined;
  let ok = false;
  try {
    response = await client.chat({
      messages,
      schema: options.schema,
      ...(typeof options.temperature === 'number'
        ? { temperature: options.temperature }
        : {}),
    });
    ok = true;
  } catch (error) {
    ok = false;
    throw error;
  } finally {
    if (options.bus && options.context) {
      const durationMs = Math.round(performance.now() - start);
      await options.bus.emit(
        createEnvelope({
          type: 'ai.session_finished',
          source: 'ai',
          level: 'info',
          context: options.context,
          message: `snapshot:${options.snapshot.digest}`,
          payload: {
            model: { provider: provider.provider, model },
            task: options.task,
            ok,
            durationMs,
          },
        }),
      );
    }
  }

  if (!response) {
    throw new Error('Cognition response missing');
  }

  if (cacheEnabled && options.inputsDigest && options.cacheDir) {
    await writeAiCache({
      cacheDir: options.cacheDir,
      key: {
        promptKind: options.task,
        inputsDigest: options.inputsDigest,
        provider: provider.provider,
        model,
      },
      content: response.content,
    });
  }

  return response.content;
}

export async function invokeAgent(options: AgentOptions): Promise<SDKResultMessage> {
  const prompt = renderConversationSnapshot(options.snapshot);
  await emitSnapshotConsumed(
    options.bus,
    options.context,
    options.snapshot.digest,
    'Agent snapshot consumed',
  );
  return runClaudePrompt({
    ...options,
    message: prompt,
  });
}
