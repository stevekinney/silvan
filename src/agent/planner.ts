import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { fetchLinearTicket } from '../linear/linear';
import { hashString } from '../utils/hash';
import { type Plan, planSchema } from './schemas';
import type { ClaudeSession } from './sdk';
import { runClaudePrompt } from './sdk';

export type PlannerInput = {
  ticketId?: string;
  worktreeName?: string;
  repoRoot: string;
  model: string;
  session?: ClaudeSession;
  bus?: EventBus;
  context: EmitContext;
};

type RepoSummary = {
  rootEntries: string[];
  packageName?: string;
};

async function summarizeRepo(repoRoot: string): Promise<RepoSummary> {
  const entries = await readdir(repoRoot, { withFileTypes: true });
  const rootEntries = entries.map((entry) => entry.name).slice(0, 50);
  let packageName: string | undefined;
  try {
    const pkg = JSON.parse(await Bun.file(join(repoRoot, 'package.json')).text()) as {
      name?: string;
    };
    packageName = pkg.name;
  } catch {
    packageName = undefined;
  }
  return {
    rootEntries,
    ...(packageName ? { packageName } : {}),
  };
}

export async function generatePlan(input: PlannerInput): Promise<Plan> {
  const ticket = input.ticketId ? await fetchLinearTicket(input.ticketId) : undefined;
  const repoSummary = await summarizeRepo(input.repoRoot);

  const prompt = [
    'You are a planning agent for the Silvan CLI.',
    'Generate a structured plan in JSON only (no Markdown).',
    '',
    `Ticket: ${ticket ? `${ticket.identifier} ${ticket.title}` : 'None'}`,
    `Description: ${ticket?.description ?? 'N/A'}`,
    `Repo package: ${repoSummary.packageName ?? 'unknown'}`,
    `Repo root entries: ${repoSummary.rootEntries.join(', ')}`,
    `Worktree: ${input.worktreeName ?? 'current'}`,
    '',
    'Plan requirements:',
    '- Ordered steps with ids.',
    '- Explicit verification steps.',
    '- Explicit files/areas likely touched.',
    '- Explicit risk/edge-case checks.',
    '- Explicit stop conditions.',
    '',
    'Return JSON with shape:',
    '{ summary: string, steps: [{id,title,description,files,verification,risks,stopConditions}], verification: string[], questions?: [{id,text,required}] }',
  ].join('\n');

  const result = await runClaudePrompt({
    message: prompt,
    model: input.model,
    permissionMode: 'plan',
    ...(input.session ? { session: input.session } : {}),
  });

  if (result.type !== 'result' || result.subtype !== 'success') {
    throw new Error(`Planner failed: ${result.subtype}`);
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
          planKind: 'ticket_plan' as const,
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
              path: issue.path.join('.') || 'plan',
              message: issue.message,
            })),
          },
        }),
      );
    }
    throw new Error('Plan schema validation failed');
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
