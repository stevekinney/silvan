import { z } from 'zod';

import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { runClaudePrompt } from './sdk';

const verificationDecisionSchema = z.object({
  commands: z.array(z.string()),
  rationale: z.string(),
  askUser: z.boolean().optional(),
});

export type VerificationDecision = z.infer<typeof verificationDecisionSchema>;

export async function decideVerification(input: {
  model: string;
  report: {
    ok: boolean;
    results: Array<{ name: string; exitCode: number; stderr: string }>;
  };
  bus?: EventBus;
  context: EmitContext;
}): Promise<VerificationDecision> {
  const prompt = [
    'You are the verification agent for Silvan.',
    'Given the verification report, decide which command(s) to run next.',
    'Return JSON only with: { commands: string[], rationale: string, askUser?: boolean }.',
    '',
    JSON.stringify(input.report, null, 2),
  ].join('\n');

  const result = await runClaudePrompt({
    message: prompt,
    model: input.model,
    permissionMode: 'plan',
  });

  if (result.type !== 'result' || result.subtype !== 'success') {
    throw new Error(`Verifier failed: ${result.subtype}`);
  }

  const raw = result.structured_output ?? result.result;
  const parsed = verificationDecisionSchema.safeParse(
    typeof raw === 'string' ? JSON.parse(raw) : raw,
  );
  if (!parsed.success) {
    throw new Error('Verification decision validation failed');
  }
  return parsed.data;
}
