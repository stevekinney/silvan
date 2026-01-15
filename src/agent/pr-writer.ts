import { type PrDraft, prDraftSchema } from './schemas';
import { runClaudePrompt } from './sdk';

export async function draftPullRequest(input: {
  model: string;
  planSummary: string;
  changesSummary: string;
  ticketUrl?: string;
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
  });

  if (result.type !== 'result' || result.subtype !== 'success') {
    throw new Error(`PR draft failed: ${result.subtype}`);
  }

  const raw = result.structured_output ?? result.result;
  const parsed = prDraftSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
  if (!parsed.success) {
    throw new Error('PR draft schema validation failed');
  }

  return parsed.data;
}
