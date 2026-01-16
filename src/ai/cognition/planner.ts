import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import { type Plan, planSchema } from '../../agent/schemas';
import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import { createEnvelope } from '../../events/emit';
import { hashInputs } from '../../prompts';
import type { Task } from '../../task/types';
import { hashString } from '../../utils/hash';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';
import { getCognitionModel, resolveCognitionProvider } from './policy';

export type PlannerInput = {
  task?: Task;
  worktreeName?: string;
  repoRoot: string;
  clarifications?: Record<string, string>;
  store: ConversationStore;
  config: Config;
  cacheDir?: string;
  bus?: EventBus;
  context?: EmitContext;
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

  const systemWriter = new ProseWriter();
  systemWriter.write('You are a planning agent for the Silvan CLI.');
  systemWriter.write('Generate a structured plan in JSON only (no Markdown).');
  systemWriter.write('Plan requirements:');
  systemWriter.list(
    'Ordered steps with ids.',
    'Explicit verification steps.',
    'Explicit files/areas likely touched.',
    'Explicit risk/edge-case checks.',
    'Explicit stop conditions.',
  );
  systemWriter.write('Return JSON with shape:');
  systemWriter.write(
    '{ summary: string, steps: [{id,title,description,files,verification,risks,stopConditions}], verification: string[], questions?: [{id,text,required}] }',
  );

  const userWriter = new ProseWriter();
  userWriter.write(`Task: ${task ? `${task.id} ${task.title}` : 'None'}`);
  userWriter.write(`Description: ${task?.description ?? 'N/A'}`);
  userWriter.write(
    `Acceptance criteria: ${task?.acceptanceCriteria?.join('; ') ?? 'N/A'}`,
  );
  userWriter.write(
    `Clarifications: ${JSON.stringify(input.clarifications ?? {}, null, 2)}`,
  );
  userWriter.write(`Repo package: ${repoSummary.packageName ?? 'unknown'}`);
  userWriter.write(`Repo root entries: ${repoSummary.rootEntries.join(', ')}`);
  userWriter.write(`Worktree: ${input.worktreeName ?? 'current'}`);

  const snapshot = await input.store.append([
    {
      role: 'system',
      content: systemWriter.toString().trimEnd(),
      metadata: { kind: 'plan' },
    },
    {
      role: 'user',
      content: userWriter.toString().trimEnd(),
      metadata: { kind: 'task', protected: true },
    },
  ]);

  const inputsDigest = hashInputs({
    task: input.task,
    clarifications: input.clarifications ?? {},
    repoSummary,
    worktreeName: input.worktreeName ?? null,
  });

  const plan = await invokeCognition({
    snapshot,
    task: 'plan',
    schema: planSchema,
    config: input.config,
    inputsDigest,
    ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
    ...(input.bus ? { bus: input.bus } : {}),
    ...(input.context ? { context: input.context } : {}),
  });

  const planDigest = hashString(JSON.stringify(plan));
  if (input.bus && input.context) {
    const provider = resolveCognitionProvider(input.config);
    const model = getCognitionModel(input.config, 'plan');
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_generated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          model: { provider: provider.provider, model },
          planKind: 'task_plan' as const,
          planDigest,
        },
      }),
    );
  }

  const parsed = planSchema.safeParse(plan);
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
              path: issue.path.join('.') || 'plan',
              message: issue.message,
            })),
          },
        }),
      );
    }
    throw new Error('Plan schema validation failed');
  }

  if (input.bus && input.context) {
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_validated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: { planDigest, valid: true },
      }),
    );
  }

  const withSummary = appendMessages(snapshot.conversation, {
    role: 'assistant',
    content: `Plan summary: ${parsed.data.summary}`,
    metadata: { kind: 'plan', protected: true },
  });
  await input.store.save(withSummary);

  return parsed.data;
}
