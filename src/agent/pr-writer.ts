import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { hashString } from '../utils/hash';
import { type PrDraft, prDraftSchema } from './schemas';
import type { ClaudeSession } from './sdk';
import { runClaudePrompt } from './sdk';

export async function draftPullRequest(input: {
  model: string;
  planSummary: string;
  changesSummary: string;
  ticketUrl?: string;
  session?: ClaudeSession;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<PrDraft> {
  const prompt = [
    'You are the PR writer for Silvan.',
    'Draft a PR title and body based on the plan and change summary.',
    'Return JSON only with: { title, body, checklist?, testing?, followUps? }.',
    '',
    `Plan summary: ${input.planSummary}`,
    `Change summary: ${input.changesSummary}`,
    `Ticket: ${input.ticketUrl ?? 'N/A'}`,
  ].join('\n');

  const result = await runClaudePrompt({
    message: prompt,
    model: input.model,
    permissionMode: 'plan',
    ...(input.session ? { session: input.session } : {}),
  });

  if (result.type !== 'result' || result.subtype !== 'success') {
    throw new Error(`PR draft failed: ${result.subtype}`);
  }

  const raw = result.structured_output ?? result.result;
  const parsed = prDraftSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
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
          planKind: 'pr_draft' as const,
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
              path: issue.path.join('.') || 'pr_draft',
              message: issue.message,
            })),
          },
        }),
      );
    }
    throw new Error('PR draft schema validation failed');
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
