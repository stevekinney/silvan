import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  ToolContext as ArmorerToolContext,
  ToolMetadata,
  ToolPolicyDecision,
} from 'armorer';
import { createArmorer, createTool } from 'armorer';
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
import { fetchLinearTicket, moveLinearTicket } from '../linear/linear';
import type { StateStore } from '../state/store';

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

const readOnlyHint = { readOnly: true, mcp: { annotations: { readOnlyHint: true } } };

function withReadOnlyHint(metadata?: ToolMetadata): ToolMetadata {
  return {
    ...readOnlyHint,
    ...(metadata ?? {}),
  };
}

// File operations are provided by Claude Code; the registry focuses on repo/API tools.
function enforcePolicy(
  toolDef: ToolDefinition<z.ZodObject<z.ZodRawShape>>,
  ctx: ToolContext,
): ToolPolicyDecision | void {
  const metadata = toolDef.metadata;
  if (metadata?.mutates) {
    if (ctx.dryRun) {
      return { allow: false, reason: 'Dry-run mode: mutating tools disabled.' };
    }
    if (!ctx.allowDestructive) {
      return { allow: false, reason: 'Use --apply to allow mutating tools.' };
    }
    if (metadata.dangerous && !ctx.allowDangerous) {
      return { allow: false, reason: 'Use --dangerous to allow this tool.' };
    }
  }
}

function toStructuredContent(result: unknown): Record<string, unknown> | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  if (Array.isArray(result)) return undefined;
  return result as Record<string, unknown>;
}

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
  const toolsByName = new Map<string, ToolDefinition<z.ZodObject<z.ZodRawShape>>>();
  const armorer = createArmorer([], {
    context,
    telemetry: true,
    digests: { input: true, output: true },
    outputValidationMode: 'report',
    readOnly: context.dryRun,
    allowMutation: context.allowDestructive,
    ...(context.toolBudget ? { budget: context.toolBudget } : {}),
    policy: {
      beforeExecute(policyContext) {
        const tool = toolsByName.get(policyContext.toolName);
        if (!tool) return;
        return enforcePolicy(tool, context);
      },
    },
    policyContext: (policyContext) => ({
      runId: context.emitContext.runId,
      repoRoot: context.repoRoot,
      worktreePath: context.worktreePath,
      ticketId: context.emitContext.ticketId,
      toolCallId: policyContext.toolCall.id,
      inputDigest: policyContext.inputDigest,
    }),
  });
  const sdkTools: Array<ReturnType<typeof sdkTool>> = [];
  const toolNames: string[] = [];
  const mutatingToolNames: string[] = [];

  const register = <TSchema extends z.ZodObject<z.ZodRawShape>>(
    definition: ToolDefinition<TSchema>,
  ): void => {
    const toolConfig = {
      name: definition.name,
      description: definition.description,
      schema: definition.schema,
      metadata: definition.metadata ?? readOnlyHint,
      async execute(params: object, _toolContext: ArmorerToolContext) {
        return definition.execute(params as z.infer<TSchema>, context);
      },
    } satisfies Parameters<typeof createTool>[0];

    const armorerTool = createTool(toolConfig, armorer);

    sdkTools.push(
      sdkTool(
        definition.name,
        definition.description,
        definition.schema.shape,
        async (args): Promise<CallToolResult> => {
          const result = await armorerTool.execute(args as Record<string, unknown>);
          const structuredContent = toStructuredContent(result);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            ...(structuredContent ? { structuredContent } : {}),
          };
        },
      ),
    );

    toolNames.push(definition.name);
    toolsByName.set(definition.name, definition);
    if (definition.metadata?.mutates) {
      mutatingToolNames.push(definition.name);
    }
  };

  register({
    name: 'silvan.state.read',
    description: 'Read persisted run state data',
    schema: z.object({ key: z.string().optional() }),
    metadata: withReadOnlyHint(),
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
    metadata: withReadOnlyHint(),
    async execute() {
      const data = await readRunState(context);
      return data['plan'];
    },
  });

  register({
    name: 'silvan.ticket.read',
    description: 'Read the current run ticket payload',
    schema: z.object({}),
    metadata: withReadOnlyHint(),
    async execute() {
      const data = await readRunState(context);
      return data['ticket'];
    },
  });

  register({
    name: 'silvan.review.read',
    description: 'Read persisted review thread fingerprints',
    schema: z.object({}),
    metadata: withReadOnlyHint(),
    async execute() {
      const data = await readRunState(context);
      return data['reviewThreads'];
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
    metadata: withReadOnlyHint(),
    async execute({ owner, repo, headBranch }) {
      return await fetchUnresolvedReviewComments({
        owner,
        repo,
        headBranch,
        ...(context.bus ? { bus: context.bus } : {}),
        context: context.emitContext,
      });
    },
  });

  register({
    name: 'github.review.thread',
    description: 'Fetch a review thread by ID',
    schema: z.object({ threadId: z.string() }),
    metadata: withReadOnlyHint(),
    async execute({ threadId }) {
      return await fetchReviewThreadById({
        threadId,
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
    metadata: withReadOnlyHint(),
    async execute({ owner, repo, headBranch, pollIntervalMs, timeoutMs }, ctx) {
      return await waitForCi({
        owner,
        repo,
        headBranch,
        pollIntervalMs: pollIntervalMs ?? 15000,
        timeoutMs: timeoutMs ?? 900000,
        ...(ctx.bus ? { bus: ctx.bus } : {}),
        context: ctx.emitContext,
      });
    },
  });

  register({
    name: 'linear.ticket.fetch',
    description: 'Fetch a Linear ticket',
    schema: z.object({ id: z.string() }),
    metadata: withReadOnlyHint(),
    async execute({ id }) {
      return await fetchLinearTicket(id);
    },
  });

  register({
    name: 'linear.ticket.move',
    description: 'Move a Linear ticket to a new state',
    schema: z.object({ id: z.string(), state: z.string() }),
    metadata: { mutates: true },
    async execute({ id, state }) {
      return await moveLinearTicket(id, state);
    },
  });

  const sdkServer = createSdkMcpServer({
    name: 'silvan-tools',
    version: '0.1.0',
    tools: sdkTools,
  });

  return { armorer, sdkServer, toolNames, mutatingToolNames };
}
