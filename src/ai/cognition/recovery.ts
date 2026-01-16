import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import { type RecoveryPlan, recoveryPlanSchema } from '../../agent/schemas';
import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import { createEnvelope } from '../../events/emit';
import { hashString } from '../../utils/hash';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';
import { getCognitionModel, resolveCognitionProvider } from './policy';

export async function generateRecoveryPlan(input: {
  runState: Record<string, unknown>;
  store: ConversationStore;
  config: Config;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<RecoveryPlan> {
  const systemWriter = new ProseWriter();
  systemWriter.write('You are the recovery agent for Silvan.');
  systemWriter.write('Given the run state, propose the safest next step.');
  systemWriter.write('Return JSON only with: { nextAction, reason, steps? }.');

  const userWriter = new ProseWriter();
  userWriter.write(JSON.stringify(input.runState, null, 2));

  const snapshot = await input.store.append([
    {
      role: 'system',
      content: systemWriter.toString().trimEnd(),
      metadata: { kind: 'recovery' },
    },
    {
      role: 'user',
      content: userWriter.toString().trimEnd(),
      metadata: { kind: 'recovery' },
    },
  ]);

  const plan = await invokeCognition({
    snapshot,
    task: 'recovery',
    schema: recoveryPlanSchema,
    config: input.config,
    ...(input.bus ? { bus: input.bus } : {}),
    ...(input.context ? { context: input.context } : {}),
  });

  const planDigest = hashString(JSON.stringify(plan));
  if (input.bus && input.context) {
    const provider = resolveCognitionProvider(input.config);
    const model = getCognitionModel(input.config, 'recovery');
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_generated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          model: { provider: provider.provider, model },
          planKind: 'recovery_plan' as const,
          planDigest,
        },
      }),
    );
  }

  const parsed = recoveryPlanSchema.safeParse(plan);
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
              path: issue.path.join('.') || 'recovery_plan',
              message: issue.message,
            })),
          },
        }),
      );
    }
    throw new Error('Recovery plan validation failed');
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

  const withSummary = appendMessages(snapshot.conversation, {
    role: 'assistant',
    content: `Recovery plan: ${parsed.data.nextAction}`,
    metadata: { kind: 'recovery', protected: true },
  });
  await input.store.save(withSummary);

  return parsed.data;
}
