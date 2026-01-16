import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import { type Plan, planSchema } from '../../agent/schemas';
import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import { createEnvelope } from '../../events/emit';
import { hashString } from '../../utils/hash';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';
import { getCognitionModel, resolveCognitionProvider } from './policy';

export async function generateCiFixPlan(input: {
  ci: {
    state: string;
    summary?: string;
    checks?: Array<{ name: string; conclusion?: string; url?: string }>;
  };
  store: ConversationStore;
  config: Config;
  bus?: EventBus;
  context: EmitContext;
}): Promise<Plan> {
  const systemWriter = new ProseWriter();
  systemWriter.write('You are the CI triage agent for Silvan.');
  systemWriter.write(
    'Given failing CI status, produce a structured fix plan in JSON only.',
  );
  systemWriter.write('Return JSON with shape: { summary, steps, verification }.');

  const userWriter = new ProseWriter();
  userWriter.write(JSON.stringify(input.ci, null, 2));

  const snapshot = await input.store.append([
    {
      role: 'system',
      content: systemWriter.toString().trimEnd(),
      metadata: { kind: 'ci' },
    },
    {
      role: 'user',
      content: userWriter.toString().trimEnd(),
      metadata: { kind: 'ci' },
    },
  ]);

  const plan = await invokeCognition({
    snapshot,
    task: 'ciTriage',
    schema: planSchema,
    config: input.config,
    ...(input.bus ? { bus: input.bus } : {}),
    context: input.context,
  });

  const planDigest = hashString(JSON.stringify(plan));
  if (input.bus) {
    const provider = resolveCognitionProvider(input.config);
    const model = getCognitionModel(input.config, 'ciTriage');
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_generated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          model: { provider: provider.provider, model },
          planKind: 'ci_fix_plan' as const,
          planDigest,
        },
      }),
    );
  }

  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) {
    if (input.bus) {
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
              path: issue.path.join('.') || 'ci_fix_plan',
              message: issue.message,
            })),
          },
        }),
      );
    }
    throw new Error('CI fix plan validation failed');
  }
  if (input.bus) {
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

  const withSummary = appendMessages(snapshot.conversation, {
    role: 'assistant',
    content: `CI fix summary: ${parsed.data.summary}`,
    metadata: { kind: 'ci', protected: true },
  });
  await input.store.save(withSummary);

  return parsed.data;
}
