import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';
import { z } from 'zod';

import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import { createEnvelope } from '../../events/emit';
import { hashString } from '../../utils/hash';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';
import { getCognitionModel, resolveCognitionProvider } from './policy';

const verificationDecisionSchema = z.object({
  commands: z.array(z.string()),
  rationale: z.string(),
  askUser: z.boolean().optional(),
});

export type VerificationDecision = z.infer<typeof verificationDecisionSchema>;

export async function decideVerification(input: {
  report: {
    ok: boolean;
    results: Array<{ name: string; exitCode: number; stderr: string }>;
  };
  store: ConversationStore;
  config: Config;
  bus?: EventBus;
  context: EmitContext;
}): Promise<VerificationDecision> {
  const systemWriter = new ProseWriter();
  systemWriter.write('You are the verification agent for Silvan.');
  systemWriter.write(
    'Given the verification report, decide which command(s) to run next.',
  );
  systemWriter.write(
    'Return JSON only with: { commands: string[], rationale: string, askUser?: boolean }.',
  );

  const userWriter = new ProseWriter();
  userWriter.write(JSON.stringify(input.report, null, 2));

  const snapshot = await input.store.append([
    {
      role: 'system',
      content: systemWriter.toString().trimEnd(),
      metadata: { kind: 'verification' },
    },
    {
      role: 'user',
      content: userWriter.toString().trimEnd(),
      metadata: { kind: 'verification' },
    },
  ]);

  const decision = await invokeCognition({
    snapshot,
    task: 'verificationSummary',
    schema: verificationDecisionSchema,
    config: input.config,
    ...(input.bus ? { bus: input.bus } : {}),
    context: input.context,
  });

  const planDigest = hashString(JSON.stringify(decision));
  if (input.bus) {
    const provider = resolveCognitionProvider(input.config);
    const model = getCognitionModel(input.config, 'verificationSummary');
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_generated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          model: { provider: provider.provider, model },
          planKind: 'verification_decision' as const,
          planDigest,
        },
      }),
    );
  }

  const parsed = verificationDecisionSchema.safeParse(decision);
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
              path: issue.path.join('.') || 'verification_decision',
              message: issue.message,
            })),
          },
        }),
      );
    }
    throw new Error('Verification decision validation failed');
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
    content: `Verification decision: ${parsed.data.rationale}`,
    metadata: { kind: 'verification', protected: true },
  });
  await input.store.save(withSummary);

  return parsed.data;
}
