import { ProseWriter } from 'prose-writer';

import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { hashString } from '../utils/hash';
import { type RecoveryPlan, recoveryPlanSchema } from './schemas';
import type { ClaudeSession } from './sdk';
import { runClaudePrompt } from './sdk';

export async function generateRecoveryPlan(input: {
  model: string;
  runState: Record<string, unknown>;
  session?: ClaudeSession;
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<RecoveryPlan> {
  const promptWriter = new ProseWriter();
  promptWriter.write('You are the recovery agent for Silvan.');
  promptWriter.write('Given the run state, propose the safest next step.');
  promptWriter.write(
    'Allowed nextAction values: rerun_verification, refetch_reviews, restart_review_loop, ask_user.',
  );
  promptWriter.write('Return JSON only with: { nextAction, reason, steps? }.');
  promptWriter.write(JSON.stringify(input.runState, null, 2));
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
    throw new Error(`Recovery plan failed: ${result.subtype}`);
  }

  const raw = result.structured_output ?? result.result;
  const parsed = recoveryPlanSchema.safeParse(
    typeof raw === 'string' ? JSON.parse(raw) : raw,
  );
  const planDigest = hashString(JSON.stringify(raw));
  if (input.bus && input.context) {
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_generated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          model: { provider: 'anthropic', model: input.model },
          planKind: 'recovery_plan' as const,
          planDigest,
        },
      }),
    );
  }
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
  return parsed.data;
}
