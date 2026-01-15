import { type ReviewFixPlan, reviewFixPlanSchema } from './schemas';
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
  });

  if (result.type !== 'result' || result.subtype !== 'success') {
    throw new Error(`Review fix plan failed: ${result.subtype}`);
  }

  const raw = result.structured_output ?? result.result;
  const parsed = reviewFixPlanSchema.safeParse(
    typeof raw === 'string' ? JSON.parse(raw) : raw,
  );
  if (!parsed.success) {
    throw new Error('Review fix plan validation failed');
  }
  return parsed.data;
}
