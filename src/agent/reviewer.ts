import { ProseWriter } from 'prose-writer';

import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { hashString } from '../utils/hash';
import { type ReviewFixPlan, reviewFixPlanSchema } from './schemas';
import type { ClaudeSession } from './sdk';
import { createToolHooks, runClaudePrompt } from './sdk';

export async function generateReviewFixPlan(input: {
  model: string;
  threads: Array<{
    threadId: string;
    comments: Array<{
      id: string;
      path?: string | null;
      line?: number | null;
      bodyDigest: string;
      excerpt?: string;
    }>;
    isOutdated: boolean;
  }>;
  diffContext?: string;
  session?: ClaudeSession;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<ReviewFixPlan> {
  const promptWriter = new ProseWriter();
  promptWriter.write('You are the review response agent for Silvan.');
  promptWriter.write('Produce a structured fix plan for unresolved review threads.');
  promptWriter.write(
    'Use github.review.thread to fetch full thread details when needed.',
  );
  promptWriter.write(
    'Return JSON only with: { threads: [{threadId, actionable, summary, comments: [{id, action}]}], verification?, resolveThreads? }.',
  );
  promptWriter.write(
    JSON.stringify(
      {
        threads: input.threads,
        diffContext: input.diffContext ?? null,
      },
      null,
      2,
    ),
  );
  const prompt = promptWriter.toString().trimEnd();

  const hooks =
    input.bus && input.context
      ? createToolHooks({ bus: input.bus, context: input.context })
      : undefined;

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
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
    ...(hooks ? { hooks } : {}),
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
