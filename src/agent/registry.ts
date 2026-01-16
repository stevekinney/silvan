import {
  createArmorer,
  createTool,
  type ToolContext as ArmorerToolContext,
  type ToolMetadata,
} from 'armorer';
import { z } from 'zod';

import type { Config } from '../config/schema';
import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { waitForCi } from '../github/ci';
import { openOrUpdatePr, requestReviewers } from '../github/pr';
import {
  fetchReviewThreadById,
  fetchUnresolvedReviewComments,
  resolveReviewThread,
} from '../github/review';
import { type ArtifactEntry, readArtifact } from '../state/artifacts';
import type { StateStore } from '../state/store';
import { createClaudeAgentSdkServer } from './claude-adapter';

export type ToolPolicy = {
  repoRoot: string;
  worktreePath?: string;
  dryRun: boolean;
  allowDestructive: boolean;
  allowDangerous: boolean;
  toolBudget?: { maxCalls?: number; maxDurationMs?: number };
  emitContext: EmitContext;
  bus?: EventBus;
  state?: StateStore;
};

export type ToolContext = ToolPolicy & {
  config: Config;
};

type ToolDefinition<TSchema extends z.ZodObject<z.ZodRawShape>> = {
  name: string;
  description: string;
  schema: TSchema;
  metadata?: ToolMetadata & { dangerous?: boolean };
  execute: (params: z.infer<TSchema>, ctx: ToolContext) => Promise<unknown>;
};

const readOnlyMetadata: ToolMetadata = { readOnly: true };

async function readRunState(ctx: ToolContext): Promise<Record<string, unknown>> {
  if (!ctx.state) {
    throw new Error('State store unavailable for this tool.');
  }
  const runId = ctx.emitContext.runId;
  const state = await ctx.state.readRunState(runId);
  const data = state?.data;
  if (!data || typeof data !== 'object') {
    return {};
  }
  return data as Record<string, unknown>;
}

export function createToolRegistry(context: ToolContext) {
  const githubToken = context.config.github.token;
  const armorer = createArmorer([], {
    context,
    telemetry: true,
    digests: { input: true, output: true },
    outputValidationMode: 'report',
    readOnly: context.dryRun,
    allowMutation: context.allowDestructive,
    ...(context.toolBudget ? { budget: context.toolBudget } : {}),
    policyContext: (policyContext) => ({
      runId: context.emitContext.runId,
      repoRoot: context.repoRoot,
      worktreePath: context.worktreePath,
      taskId: context.emitContext.taskId,
      toolCallId: policyContext.toolCall.id,
      inputDigest: policyContext.inputDigest,
    }),
  });
  const register = <TSchema extends z.ZodObject<z.ZodRawShape>>(
    definition: ToolDefinition<TSchema>,
  ): void => {
    const toolConfig = {
      name: definition.name,
      description: definition.description,
      schema: definition.schema,
      metadata: definition.metadata ?? readOnlyMetadata,
      async execute(params: object, _toolContext: ArmorerToolContext) {
        return definition.execute(params as z.infer<TSchema>, context);
      },
    } satisfies Parameters<typeof createTool>[0];

    createTool(toolConfig, armorer);
  };

  register({
    name: 'silvan.state.read',
    description: 'Read persisted run state data',
    schema: z.object({ key: z.string().optional() }),
    metadata: readOnlyMetadata,
    async execute({ key }) {
      const data = await readRunState(context);
      if (!key) return data;
      return data[key];
    },
  });

  register({
    name: 'silvan.plan.read',
    description: 'Read the current run plan',
    schema: z.object({}),
    metadata: readOnlyMetadata,
    async execute() {
      const data = await readRunState(context);
      return data['plan'];
    },
  });

  register({
    name: 'silvan.task.read',
    description: 'Read the current run task payload',
    schema: z.object({}),
    metadata: readOnlyMetadata,
    async execute() {
      const data = await readRunState(context);
      return data['task'];
    },
  });

  register({
    name: 'silvan.review.read',
    description: 'Read persisted review thread fingerprints',
    schema: z.object({}),
    metadata: readOnlyMetadata,
    async execute() {
      const data = await readRunState(context);
      const index = data['artifactsIndex'] as
        | Record<string, Record<string, ArtifactEntry>>
        | undefined;
      const entry = index?.['github.review.fetch']?.['threads'];
      if (!entry || entry.kind !== 'json') return undefined;
      return readArtifact({ entry });
    },
  });

  register({
    name: 'github.pr.open',
    description: 'Open or update a pull request',
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      headBranch: z.string(),
      baseBranch: z.string(),
      title: z.string(),
      body: z.string(),
    }),
    metadata: { mutates: true },
    async execute({ owner, repo, headBranch, baseBranch, title, body }) {
      return await openOrUpdatePr({
        owner,
        repo,
        headBranch,
        baseBranch,
        title,
        body,
        ...(githubToken ? { token: githubToken } : {}),
        ...(context.bus ? { bus: context.bus } : {}),
        context: context.emitContext,
      });
    },
  });

  register({
    name: 'github.review.request',
    description: 'Request reviewers for a PR',
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number(),
      reviewers: z.array(z.string()),
      requestCopilot: z.boolean().optional(),
    }),
    metadata: { mutates: true },
    async execute({ owner, repo, number, reviewers, requestCopilot }) {
      await requestReviewers({
        pr: { owner, repo, number },
        reviewers,
        requestCopilot: requestCopilot ?? true,
        ...(githubToken ? { token: githubToken } : {}),
        ...(context.bus ? { bus: context.bus } : {}),
        context: context.emitContext,
      });
      return { ok: true };
    },
  });

  register({
    name: 'github.review.fetch',
    description: 'Fetch unresolved review threads',
    schema: z.object({ owner: z.string(), repo: z.string(), headBranch: z.string() }),
    metadata: readOnlyMetadata,
    async execute({ owner, repo, headBranch }) {
      return await fetchUnresolvedReviewComments({
        owner,
        repo,
        headBranch,
        ...(githubToken ? { token: githubToken } : {}),
        ...(context.bus ? { bus: context.bus } : {}),
        context: context.emitContext,
      });
    },
  });

  register({
    name: 'github.review.thread',
    description: 'Fetch a review thread by ID',
    schema: z.object({ threadId: z.string() }),
    metadata: readOnlyMetadata,
    async execute({ threadId }) {
      return await fetchReviewThreadById({
        threadId,
        ...(githubToken ? { token: githubToken } : {}),
        ...(context.bus ? { bus: context.bus } : {}),
        context: context.emitContext,
      });
    },
  });

  register({
    name: 'github.review.resolve',
    description: 'Resolve a review thread',
    schema: z.object({ threadId: z.string() }),
    metadata: { mutates: true },
    async execute({ threadId }) {
      return await resolveReviewThread({
        threadId,
        ...(githubToken ? { token: githubToken } : {}),
        ...(context.bus ? { bus: context.bus } : {}),
        context: context.emitContext,
      });
    },
  });

  register({
    name: 'github.ci.wait',
    description: 'Wait for CI checks to complete',
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      headBranch: z.string(),
      pollIntervalMs: z.number().optional(),
      timeoutMs: z.number().optional(),
    }),
    metadata: readOnlyMetadata,
    async execute({ owner, repo, headBranch, pollIntervalMs, timeoutMs }, ctx) {
      return await waitForCi({
        owner,
        repo,
        headBranch,
        pollIntervalMs: pollIntervalMs ?? 15000,
        timeoutMs: timeoutMs ?? 900000,
        ...(githubToken ? { token: githubToken } : {}),
        ...(ctx.bus ? { bus: ctx.bus } : {}),
        context: ctx.emitContext,
      });
    },
  });

  const { sdkServer, toolNames, mutatingToolNames, dangerousToolNames } =
    createClaudeAgentSdkServer(armorer, {
      name: 'silvan-tools',
      version: '0.1.0',
    });

  return { armorer, sdkServer, toolNames, mutatingToolNames, dangerousToolNames };
}
