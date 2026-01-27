import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import { type Plan, planSchema } from '../../agent/schemas';
import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import { createEnvelope } from '../../events/emit';
import { hashString } from '../../utils/hash';
import { truncateLines } from '../../utils/text';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';
import { getCognitionModel, resolveCognitionProvider } from './policy';

export async function generateVerificationFixPlan(input: {
  failures: Array<{
    name: string;
    exitCode: number;
    stderr: string;
    command?: string;
  }>;
  store: ConversationStore;
  config: Config;
  bus?: EventBus;
  context: EmitContext;
  invoke?: typeof invokeCognition;
  client?: Parameters<typeof invokeCognition>[0]['client'];
}): Promise<Plan> {
  const formattedFailures = input.failures.map((failure) => {
    const excerpt = truncateLines(failure.stderr ?? '', {
      maxLines: 12,
      maxChars: 2000,
    });
    return {
      name: failure.name,
      exitCode: failure.exitCode,
      ...(failure.command ? { command: failure.command } : {}),
      stderr: excerpt.lines.join('\n'),
      truncated: excerpt.truncated,
    };
  });

  const systemWriter = new ProseWriter();
  systemWriter.write('You are the verification recovery agent for Silvan.');
  systemWriter.write(
    'Given failed verification commands and stderr excerpts, produce a structured fix plan in JSON only.',
  );
  systemWriter.write(
    'Keep fixes minimal and focused on resolving the verification failures.',
  );
  systemWriter.write('Return JSON with shape: { summary, steps, verification }.');

  const userWriter = new ProseWriter();
  userWriter.write(JSON.stringify({ failures: formattedFailures }, null, 2));

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

  const invoke = input.invoke ?? invokeCognition;
  const plan = await invoke({
    snapshot,
    task: 'verificationFix',
    schema: planSchema,
    config: input.config,
    ...(input.client ? { client: input.client } : {}),
    ...(input.bus ? { bus: input.bus } : {}),
    context: input.context,
  });

  const planDigest = hashString(JSON.stringify(plan));
  if (input.bus) {
    const provider = resolveCognitionProvider(input.config);
    const model = getCognitionModel(input.config, 'verificationFix');
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_generated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          model: { provider: provider.provider, model },
          planKind: 'verification_fix_plan' as const,
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
              path: issue.path.join('.') || 'verification_fix_plan',
              message: issue.message,
            })),
          },
        }),
      );
    }
    throw new Error('Verification fix plan validation failed');
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
    content: `Verification fix summary: ${parsed.data.summary}`,
    metadata: { kind: 'verification', protected: true },
  });
  await input.store.save(withSummary);

  return parsed.data;
}
