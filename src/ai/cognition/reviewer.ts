import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';
import type { ZodSchema } from 'zod';

import { type ReviewFixPlan, reviewFixPlanSchema } from '../../agent/schemas';
import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import { createEnvelope } from '../../events/emit';
import { hashInputs } from '../../prompts';
import { hashString } from '../../utils/hash';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';
import { getCognitionModel, resolveCognitionProvider } from './policy';

export async function generateReviewFixPlan(input: {
  threads: Array<{
    threadId: string;
    comments: Array<{
      id: string;
      path: string | null;
      line: number | null;
      bodyDigest: string;
      body?: string;
      excerpt?: string;
    }>;
    isOutdated: boolean;
  }>;
  diffContext?: string;
  store: ConversationStore;
  config: Config;
  cacheDir?: string;
  client?: {
    chat: (options: {
      messages: unknown;
      schema: ZodSchema<ReviewFixPlan>;
    }) => Promise<{ content: ReviewFixPlan }>;
  };
  bus?: EventBus;
  context?: EmitContext;
}): Promise<ReviewFixPlan> {
  const systemWriter = new ProseWriter();
  systemWriter.write('You are the review response agent for Silvan.');
  systemWriter.write('Produce a structured fix plan for unresolved review threads.');
  systemWriter.write(
    'Some comment bodies may be truncated; use body when provided, otherwise rely on excerpts and digests.',
  );
  systemWriter.write(
    'Return JSON only with: { threads: [{threadId, actionable, summary, comments: [{id, action}]}], verification?, resolveThreads? }.',
  );

  const userWriter = new ProseWriter();
  userWriter.write(
    JSON.stringify(
      {
        threads: input.threads,
        diffContext: input.diffContext ?? null,
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

  const inputsDigest = hashInputs({
    threads: input.threads,
    diffContext: input.diffContext ?? null,
  });

  const plan = await invokeCognition({
    snapshot,
    task: 'reviewCluster',
    schema: reviewFixPlanSchema,
    config: input.config,
    inputsDigest,
    ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
    ...(input.client ? { client: input.client } : {}),
    ...(input.bus ? { bus: input.bus } : {}),
    ...(input.context ? { context: input.context } : {}),
  });

  const planDigest = hashString(JSON.stringify(plan));
  if (input.bus && input.context) {
    const provider = resolveCognitionProvider(input.config);
    const model = getCognitionModel(input.config, 'reviewCluster');
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_generated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          model: { provider: provider.provider, model },
          planKind: 'review_fix_plan' as const,
          planDigest,
        },
      }),
    );
  }
  const parsed = reviewFixPlanSchema.safeParse(plan);
  if (!parsed.success) {
    if (input.bus && input.context) {
      await input.bus.emit(
        createEnvelope({
          type: 'ai.plan_validated',
          source: 'ai',
          level: 'error',
          context: input.context,
          payload: {
            planDigest,
            valid: false,
            errors: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.') || 'review_fix_plan',
              message: issue.message,
            })),
          },
        }),
      );
    }
    throw new Error('Review fix plan validation failed');
  }
  if (input.bus && input.context) {
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_validated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          planDigest,
          valid: true,
        },
      }),
    );
  }

  const summaryParts = parsed.data.threads.map(
    (thread) => `${thread.threadId}: ${thread.summary}`,
  );
  const withSummary = appendMessages(snapshot.conversation, {
    role: 'assistant',
    content: `Review plan summary:\n${summaryParts.join('\n')}`,
    metadata: { kind: 'review', protected: true },
  });
  await input.store.save(withSummary);

  return parsed.data;
}
