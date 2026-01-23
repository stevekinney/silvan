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
import { hashInputs } from '../../prompts';
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
  cacheDir?: string;
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
    'Return JSON only with: { actionableThreadIds, ignoredThreadIds, needsContextThreadIds, threads?, clusters? }.',
  );
  systemWriter.write(
    'Use needsContextThreadIds only when full comment bodies are required to decide.',
  );
  systemWriter.write(
    'For threads, include { threadId, severity, summary } for each thread you can assess.',
  );
  systemWriter.write(
    'Severity values: blocking, question, suggestion, nitpick. Use nitpick sparingly for low-impact style feedback.',
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

  const inputsDigest = hashInputs({ threads: input.threads });

  const classification = await invokeCognition({
    snapshot,
    task: 'reviewClassify',
    schema: reviewClassificationSchema,
    config: input.config,
    inputsDigest,
    ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
    ...(input.client ? { client: input.client } : {}),
    ...(input.bus ? { bus: input.bus } : {}),
    ...(input.context ? { context: input.context } : {}),
  });

  const parsed = reviewClassificationSchema.safeParse(classification);
  if (!parsed.success) {
    throw new Error('Review classification validation failed');
  }

  const summaryParts = [
    `actionable: ${parsed.data.actionableThreadIds.length}`,
    `ignored: ${parsed.data.ignoredThreadIds.length}`,
    `needsContext: ${parsed.data.needsContextThreadIds.length}`,
  ];
  if (parsed.data.threads?.length) {
    summaryParts.push(`threads: ${parsed.data.threads.length}`);
  }
  const summary = summaryParts.join(', ');

  const withSummary = appendMessages(snapshot.conversation, {
    role: 'assistant',
    content: `Review classification summary: ${summary}`,
    metadata: { kind: 'review', protected: true },
  });
  await input.store.save(withSummary);

  return parsed.data;
}
