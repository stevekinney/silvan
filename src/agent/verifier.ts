import { z } from 'zod';

import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { hashString } from '../utils/hash';
import type { ClaudeSession } from './sdk';
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
  session?: ClaudeSession;
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
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
    throw new Error(`Verifier failed: ${result.subtype}`);
  }

  const raw = result.structured_output ?? result.result;
  const parsed = verificationDecisionSchema.safeParse(
    typeof raw === 'string' ? JSON.parse(raw) : raw,
  );
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
          planKind: 'verification_decision' as const,
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
  return parsed.data;
}
