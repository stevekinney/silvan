import { type RecoveryPlan, recoveryPlanSchema } from './schemas';
import { runClaudePrompt } from './sdk';

export async function generateRecoveryPlan(input: {
  model: string;
  runState: Record<string, unknown>;
}): Promise<RecoveryPlan> {
  const prompt = [
    'You are the recovery agent for Silvan.',
    'Given the run state, propose the safest next step.',
    'Return JSON only with: { nextAction, reason, steps? }.',
    '',
    JSON.stringify(input.runState, null, 2),
  ].join('\n');

  const result = await runClaudePrompt({
    message: prompt,
    model: input.model,
    permissionMode: 'plan',
  });

  if (result.type !== 'result' || result.subtype !== 'success') {
    throw new Error(`Recovery plan failed: ${result.subtype}`);
  }

  const raw = result.structured_output ?? result.result;
  const parsed = recoveryPlanSchema.safeParse(
    typeof raw === 'string' ? JSON.parse(raw) : raw,
  );
  if (!parsed.success) {
    throw new Error('Recovery plan validation failed');
  }
  return parsed.data;
}
