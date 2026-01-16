import { ProseWriter } from 'prose-writer';

import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { hashString } from '../utils/hash';
import { type Plan, planSchema } from './schemas';
import type { ClaudeSession } from './sdk';
import { runClaudePrompt } from './sdk';

export async function generateCiFixPlan(input: {
  model: string;
  ci: {
    state: string;
    summary?: string;
    checks?: Array<{ name: string; conclusion?: string; url?: string }>;
  };
  session?: ClaudeSession;
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
  bus?: EventBus;
  context: EmitContext;
}): Promise<Plan> {
  const promptWriter = new ProseWriter();
  promptWriter.write('You are the CI triage agent for Silvan.');
  promptWriter.write(
    'Given failing CI status, produce a structured fix plan in JSON only.',
  );
  promptWriter.write('Return JSON with shape: { summary, steps, verification }.');
  promptWriter.write(JSON.stringify(input.ci, null, 2));
  const prompt = promptWriter.toString().trimEnd();

  const result = await runClaudePrompt({
    message: prompt,
    model: input.model,
    permissionMode: 'plan',
    ...(typeof input.maxTurns === 'number' ? { maxTurns: input.maxTurns } : {}),
    ...(typeof input.maxBudgetUsd === 'number'
      ? { maxBudgetUsd: input.maxBudgetUsd }
      : {}),
    ...(typeof input.maxThinkingTokens === 'number'
      ? { maxThinkingTokens: input.maxThinkingTokens }
      : {}),
    ...(input.session ? { session: input.session } : {}),
  });

  if (result.type !== 'result' || result.subtype !== 'success') {
    throw new Error(`CI fix plan failed: ${result.subtype}`);
  }

  const raw = result.structured_output ?? result.result;
  const parsed = planSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
  const planDigest = hashString(JSON.stringify(raw));
  if (input.bus) {
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_generated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          model: { provider: 'anthropic', model: input.model },
          planKind: 'ci_fix_plan' as const,
          planDigest,
        },
      }),
    );
  }
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

  return parsed.data;
}
