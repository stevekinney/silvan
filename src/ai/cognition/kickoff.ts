import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';
import { z } from 'zod';

import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import {
  hashInputs,
  hashPrompt,
  renderPromptSummary,
  validatePrompt,
} from '../../prompts';
import {
  type ExecutionKickoffBody,
  executionKickoffPromptSchema,
} from '../../prompts/schema';
import type { ExecutionKickoffPrompt } from '../../prompts/types';
import type { Task } from '../../task/types';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';

type RepoProfile = {
  rootEntries: string[];
  packageName?: string;
};

const executionKickoffBodyLooseSchema = z.object({}).passthrough();

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
  const fallbackBody = buildExecutionKickoffFallback({
    task: input.task,
    repoProfile,
    config: input.config,
  });
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
    schema: executionKickoffBodyLooseSchema,
    config: input.config,
    ...(input.bus ? { bus: input.bus } : {}),
    ...(input.context ? { context: input.context } : {}),
  }).catch(() => null);

  const normalizedBody = normalizeExecutionKickoffBody(body, fallbackBody);

  const envelope: ExecutionKickoffPrompt = {
    promptVersion: '1.0',
    promptKind: 'execution_kickoff',
    createdAt: new Date().toISOString(),
    source: 'silvan',
    id: crypto.randomUUID(),
    inputsDigest,
    body: normalizedBody,
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

type ExecutionKickoffBodyInput = Record<string, unknown> | null;

type ExecutionKickoffFallbackInput = {
  task: Task;
  repoProfile: RepoProfile;
  config: Config;
};

function buildExecutionKickoffFallback(
  input: ExecutionKickoffFallbackInput,
): ExecutionKickoffBody {
  const taskKey = input.task.key ?? input.task.id;
  const summary = summarizeTask(input.task);
  const acceptanceCriteria = normalizeFallbackList(input.task.acceptanceCriteria, [
    summary,
  ]);
  const entrypoints = inferEntrypoints(input.repoProfile.rootEntries);
  const verification = normalizeFallbackList(
    input.config.verify.commands.map((command) => command.cmd),
    ['Run configured verification commands'],
  );

  return {
    objective: `Implement ${input.task.title}`,
    context: {
      task: {
        key: taskKey,
        title: input.task.title,
        summary,
        acceptanceCriteria,
      },
      repo: {
        type: input.repoProfile.packageName ? 'package' : 'repo',
        frameworks: [],
        keyPackages: input.repoProfile.packageName ? [input.repoProfile.packageName] : [],
        entrypoints,
      },
    },
    constraints: {
      mustDo: ['Follow the acceptance criteria'],
      mustNotDo: ['Avoid unrelated refactors'],
      assumptions: ['Requirements limited to the task description'],
    },
    executionRules: {
      readBeforeWrite: true,
      noSpeculativeChanges: true,
      toolDrivenOnly: true,
      smallCommitsPreferred: true,
    },
    successDefinition: {
      functional: acceptanceCriteria,
      verification,
      nonGoals: ['No unrelated refactors'],
    },
    suggestedApproach: [
      'Review relevant code and tests',
      'Implement the required changes',
      'Update or add tests',
      'Run verification commands',
    ],
  };
}

export function normalizeExecutionKickoffBody(
  candidate: ExecutionKickoffBodyInput,
  fallback: ExecutionKickoffBody,
): ExecutionKickoffBody {
  const input = candidate ?? {};
  const context = asRecord(input['context']);
  const task = asRecord(context?.['task']);
  const repo = asRecord(context?.['repo']);
  const constraints = asRecord(input['constraints']);
  const executionRules = asRecord(input['executionRules']);
  const successDefinition = asRecord(input['successDefinition']);

  const normalized: ExecutionKickoffBody = {
    objective: coerceString(input['objective'], fallback.objective),
    context: {
      task: {
        key: coerceString(task?.['key'], fallback.context.task.key),
        title: coerceString(task?.['title'], fallback.context.task.title),
        summary: coerceString(task?.['summary'], fallback.context.task.summary),
        acceptanceCriteria: coerceStringList(
          task?.['acceptanceCriteria'],
          fallback.context.task.acceptanceCriteria,
        ),
      },
      repo: {
        type: coerceString(repo?.['type'], fallback.context.repo.type),
        frameworks: coerceStringList(
          repo?.['frameworks'],
          fallback.context.repo.frameworks,
        ),
        keyPackages: coerceStringList(
          repo?.['keyPackages'],
          fallback.context.repo.keyPackages,
        ),
        entrypoints: coerceStringList(
          repo?.['entrypoints'],
          fallback.context.repo.entrypoints,
        ),
      },
    },
    constraints: {
      mustDo: coerceStringList(constraints?.['mustDo'], fallback.constraints.mustDo),
      mustNotDo: coerceStringList(
        constraints?.['mustNotDo'],
        fallback.constraints.mustNotDo,
      ),
      assumptions: coerceStringList(
        constraints?.['assumptions'],
        fallback.constraints.assumptions,
      ),
    },
    executionRules: {
      readBeforeWrite: coerceBoolean(
        executionRules?.['readBeforeWrite'],
        fallback.executionRules.readBeforeWrite,
      ),
      noSpeculativeChanges: coerceBoolean(
        executionRules?.['noSpeculativeChanges'],
        fallback.executionRules.noSpeculativeChanges,
      ),
      toolDrivenOnly: coerceBoolean(
        executionRules?.['toolDrivenOnly'],
        fallback.executionRules.toolDrivenOnly,
      ),
      smallCommitsPreferred: coerceBoolean(
        executionRules?.['smallCommitsPreferred'],
        fallback.executionRules.smallCommitsPreferred,
      ),
    },
    successDefinition: {
      functional: coerceStringList(
        successDefinition?.['functional'],
        fallback.successDefinition.functional,
      ),
      verification: coerceStringList(
        successDefinition?.['verification'],
        fallback.successDefinition.verification,
      ),
      nonGoals: coerceStringList(
        successDefinition?.['nonGoals'],
        fallback.successDefinition.nonGoals,
      ),
    },
    suggestedApproach: coerceStringList(
      input['suggestedApproach'],
      fallback.suggestedApproach,
    ),
  };

  return executionKickoffPromptSchema.shape.body.parse(normalized);
}

function summarizeTask(task: Task): string {
  const lines = task.description
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0];
  if (firstLine) {
    return firstLine.slice(0, 160);
  }
  return task.title;
}

function inferEntrypoints(entries: string[]): string[] {
  if (entries.includes('src')) return ['src'];
  if (entries.includes('app')) return ['app'];
  if (entries.includes('lib')) return ['lib'];
  return [];
}

function normalizeFallbackList(items: string[], fallback: string[]): string[] {
  const normalized = items.map((item) => item.trim()).filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function coerceString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function coerceStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const trimmed = value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return trimmed.length > 0 ? trimmed : fallback;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}
