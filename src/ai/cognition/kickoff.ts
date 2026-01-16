import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import {
  hashInputs,
  hashPrompt,
  renderPromptSummary,
  validatePrompt,
} from '../../prompts';
import { executionKickoffPromptSchema } from '../../prompts/schema';
import type { ExecutionKickoffPrompt } from '../../prompts/types';
import type { Task } from '../../task/types';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';

type RepoProfile = {
  rootEntries: string[];
  packageName?: string;
};

async function summarizeRepo(repoRoot: string): Promise<RepoProfile> {
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

export async function generateExecutionKickoffPrompt(input: {
  task: Task;
  repoRoot: string;
  store: ConversationStore;
  config: Config;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<ExecutionKickoffPrompt> {
  const repoProfile = await summarizeRepo(input.repoRoot);
  const inputsDigest = hashInputs({
    task: {
      id: input.task.id,
      key: input.task.key ?? input.task.id,
      title: input.task.title,
      description: input.task.description,
      acceptanceCriteria: input.task.acceptanceCriteria,
    },
    repoProfile,
  });
  const systemWriter = new ProseWriter();
  systemWriter.write('You are a prompt architect for an implementation run.');
  systemWriter.write(
    'Generate a concise execution kickoff prompt body in JSON only, matching the required schema.',
  );
  systemWriter.write('Be explicit, avoid ambiguity, and prefer actionable bullets.');

  const userWriter = new ProseWriter();
  userWriter.write(`Task: ${input.task.key ?? input.task.id} ${input.task.title}`);
  userWriter.write(`Description: ${input.task.description ?? 'N/A'}`);
  userWriter.write(
    `Acceptance criteria: ${input.task.acceptanceCriteria?.join('; ') ?? 'N/A'}`,
  );
  userWriter.write(`Repo package: ${repoProfile.packageName ?? 'unknown'}`);
  userWriter.write(`Repo root entries: ${repoProfile.rootEntries.join(', ')}`);

  const snapshot = await input.store.append([
    {
      role: 'system',
      content: systemWriter.toString().trimEnd(),
      metadata: { kind: 'kickoff' },
    },
    {
      role: 'user',
      content: userWriter.toString().trimEnd(),
      metadata: { kind: 'task', protected: true },
    },
  ]);

  const body = await invokeCognition({
    snapshot,
    task: 'kickoffPrompt',
    schema: executionKickoffPromptSchema.shape.body,
    config: input.config,
    ...(input.bus ? { bus: input.bus } : {}),
    ...(input.context ? { context: input.context } : {}),
  });

  const envelope: ExecutionKickoffPrompt = {
    promptVersion: '1.0',
    promptKind: 'execution_kickoff',
    createdAt: new Date().toISOString(),
    source: 'silvan',
    id: crypto.randomUUID(),
    inputsDigest,
    body,
  };

  const validated = validatePrompt('execution_kickoff', envelope);
  const promptDigest = hashPrompt(validated);

  const withSummary = appendMessages(snapshot.conversation, {
    role: 'assistant',
    content: `${renderPromptSummary(validated)} - ${promptDigest}`,
    metadata: { kind: 'kickoff', protected: true },
  });
  await input.store.save(withSummary);

  return validated as ExecutionKickoffPrompt;
}
