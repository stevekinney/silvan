import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { hashString } from '../utils/hash';
import { type ReviewFixPlan, reviewFixPlanSchema } from './schemas';
import type { ClaudeSession } from './sdk';
import { runClaudePrompt } from './sdk';

export async function generateReviewFixPlan(input: {
  model: string;
  threads: Array<{
    threadId: string;
    comments: Array<{
      id: string;
      body: string;
      path?: string | null;
      line?: number | null;
    }>;
    isOutdated: boolean;
  }>;
  diffContext?: string;
  session?: ClaudeSession;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<ReviewFixPlan> {
  const prompt = [
    'You are the review response agent for Silvan.',
    'Produce a structured fix plan for unresolved review threads.',
    'Return JSON only with: { threads: [{threadId, actionable, summary, comments: [{id, action}]}], verification?, resolveThreads? }.',
    '',
    JSON.stringify(
      {
        threads: input.threads,
        diffContext: input.diffContext ?? null,
      },
      null,
      2,
    ),
  ].join('\n');

  const result = await runClaudePrompt({
    message: prompt,
    model: input.model,
    permissionMode: 'plan',
    ...(input.session ? { session: input.session } : {}),
  });

  if (result.type !== 'result' || result.subtype !== 'success') {
    throw new Error(`Review fix plan failed: ${result.subtype}`);
  }

  const raw = result.structured_output ?? result.result;
  const parsed = reviewFixPlanSchema.safeParse(
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
          planKind: 'review_fix_plan' as const,
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
              path: issue.path.join('.') || 'review_fix_plan',
              message: issue.message,
            })),
          },
        }),
      );
    }
    throw new Error('Review fix plan validation failed');
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
