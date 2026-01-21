import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';
import { z } from 'zod';

import { getCognitionModel, resolveCognitionProvider } from '../ai/cognition/policy';
import type { ConversationStore } from '../ai/conversation/types';
import { invokeCognition } from '../ai/router';
import type { Config } from '../config/schema';
import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';

export const aiReviewerSchema = z
  .object({
    shipIt: z.boolean(),
    issues: z.array(
      z.object({
        severity: z.enum(['blocker', 'warn', 'info']),
        note: z.string().min(1),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        suggestion: z.string().optional(),
      }),
    ),
  })
  .strict();

export type AiReviewReport = z.infer<typeof aiReviewerSchema>;

export async function runAiReviewer(options: {
  summary: {
    diffStat: string;
    findings: Array<{ severity: string; title: string; file?: string }>;
  };
  task?: {
    key?: string;
    title?: string;
    acceptanceCriteria?: string[];
  };
  store: ConversationStore;
  config: Config;
  bus?: EventBus;
  context?: EmitContext;
  invoke?: typeof invokeCognition;
  client?: Parameters<typeof invokeCognition>[0]['client'];
}): Promise<AiReviewReport> {
  const systemWriter = new ProseWriter();
  systemWriter.write('You are a code review assistant.');
  systemWriter.write('Review the summarized changes and local gate findings.');
  systemWriter.write('Check whether the task acceptance criteria appear satisfied.');
  systemWriter.write(
    'Return JSON only: { shipIt: boolean, issues: [{severity, note, file?, line?, suggestion?}] }.',
  );
  systemWriter.write('Do not request large diffs or full file contents.');

  const userWriter = new ProseWriter();
  userWriter.write(
    JSON.stringify(
      {
        task: options.task,
        diffStat: options.summary.diffStat,
        findings: options.summary.findings,
      },
      null,
      2,
    ),
  );

  const snapshot = await options.store.append([
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

  const invoke = options.invoke ?? invokeCognition;
  const report = await invoke({
    snapshot,
    task: 'localReview',
    schema: aiReviewerSchema,
    config: options.config,
    ...(options.client ? { client: options.client } : {}),
    ...(options.bus ? { bus: options.bus } : {}),
    ...(options.context ? { context: options.context } : {}),
  });

  if (options.bus && options.context) {
    const provider = resolveCognitionProvider(options.config);
    const model = getCognitionModel(options.config, 'localReview');
    await options.bus.emit(
      createEnvelope({
        type: 'run.step',
        source: 'ai',
        level: 'info',
        context: options.context,
        payload: {
          stepId: 'review.ai_reviewer',
          title: `AI review (${provider.provider}/${model})`,
          status: 'succeeded' as const,
        },
      }),
    );
  }

  const parsed = aiReviewerSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error('AI reviewer validation failed');
  }
  const summaryLines = parsed.data.issues.map((issue) => issue.note);
  const withSummary = appendMessages(snapshot.conversation, {
    role: 'assistant',
    content: `AI review summary:\n${summaryLines.join('\n')}`,
    metadata: { kind: 'review', protected: true },
  });
  await options.store.save(withSummary);

  return parsed.data;
}
