import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';
import type { ZodSchema } from 'zod';

import {
  type ReviewClassification,
  reviewClassificationSchema,
} from '../../agent/schemas';
import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';

export async function classifyReviewThreads(input: {
  threads: Array<{
    threadId: string;
    comments: Array<{
      id: string;
      path: string | null;
      line: number | null;
      bodyDigest: string;
      excerpt?: string;
    }>;
    isOutdated: boolean;
  }>;
  store: ConversationStore;
  config: Config;
  client?: {
    chat: (options: {
      messages: unknown;
      schema: ZodSchema<ReviewClassification>;
    }) => Promise<{ content: ReviewClassification }>;
  };
  bus?: EventBus;
  context?: EmitContext;
}): Promise<ReviewClassification> {
  const systemWriter = new ProseWriter();
  systemWriter.write('You are the review triage agent for Silvan.');
  systemWriter.write('Classify review threads using only fingerprints and excerpts.');
  systemWriter.write(
    'Return JSON only with: { actionableThreadIds, ignoredThreadIds, needsContextThreadIds, clusters? }.',
  );
  systemWriter.write(
    'Use needsContextThreadIds only when full comment bodies are required to decide.',
  );

  const userWriter = new ProseWriter();
  userWriter.write(
    JSON.stringify(
      {
        threads: input.threads,
      },
      null,
      2,
    ),
  );

  const snapshot = await input.store.append([
    {
      role: 'system',
      content: systemWriter.toString().trimEnd(),
      metadata: { kind: 'review' },
    },
    {
      role: 'user',
      content: userWriter.toString().trimEnd(),
      metadata: { kind: 'review' },
    },
  ]);

  const classification = await invokeCognition({
    snapshot,
    task: 'reviewClassify',
    schema: reviewClassificationSchema,
    config: input.config,
    ...(input.client ? { client: input.client } : {}),
    ...(input.bus ? { bus: input.bus } : {}),
    ...(input.context ? { context: input.context } : {}),
  });

  const parsed = reviewClassificationSchema.safeParse(classification);
  if (!parsed.success) {
    throw new Error('Review classification validation failed');
  }

  const summary = [
    `actionable: ${parsed.data.actionableThreadIds.length}`,
    `ignored: ${parsed.data.ignoredThreadIds.length}`,
    `needsContext: ${parsed.data.needsContextThreadIds.length}`,
  ].join(', ');

  const withSummary = appendMessages(snapshot.conversation, {
    role: 'assistant',
    content: `Review classification summary: ${summary}`,
    metadata: { kind: 'review', protected: true },
  });
  await input.store.save(withSummary);

  return parsed.data;
}
