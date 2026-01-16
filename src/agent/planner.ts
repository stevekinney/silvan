import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ProseWriter } from 'prose-writer';

import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import type { Task } from '../task/types';
import { hashString } from '../utils/hash';
import { type Plan, planSchema } from './schemas';
import type { ClaudeSession } from './sdk';
import { runClaudePrompt } from './sdk';

export type PlannerInput = {
  task?: Task;
  worktreeName?: string;
  repoRoot: string;
  model: string;
  clarifications?: Record<string, string>;
  session?: ClaudeSession;
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
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
  const repoSummary = await summarizeRepo(input.repoRoot);
  const task = input.task;

  const promptWriter = new ProseWriter();
  promptWriter.write('You are a planning agent for the Silvan CLI.');
  promptWriter.write('Generate a structured plan in JSON only (no Markdown).');
  promptWriter.write(`Task: ${task ? `${task.id} ${task.title}` : 'None'}`);
  promptWriter.write(`Description: ${task?.description ?? 'N/A'}`);
  promptWriter.write(
    `Acceptance criteria: ${task?.acceptanceCriteria?.join('; ') ?? 'N/A'}`,
  );
  promptWriter.write(
    `Clarifications: ${JSON.stringify(input.clarifications ?? {}, null, 2)}`,
  );
  promptWriter.write(`Repo package: ${repoSummary.packageName ?? 'unknown'}`);
  promptWriter.write(`Repo root entries: ${repoSummary.rootEntries.join(', ')}`);
  promptWriter.write(`Worktree: ${input.worktreeName ?? 'current'}`);
  promptWriter.write('Plan requirements:');
  promptWriter.list(
    'Ordered steps with ids.',
    'Explicit verification steps.',
    'Explicit files/areas likely touched.',
    'Explicit risk/edge-case checks.',
    'Explicit stop conditions.',
  );
  promptWriter.write('Return JSON with shape:');
  promptWriter.write(
    '{ summary: string, steps: [{id,title,description,files,verification,risks,stopConditions}], verification: string[], questions?: [{id,text,required}] }',
  );
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
          planKind: 'task_plan' as const,
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
