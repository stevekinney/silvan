import { resolve } from 'node:path';

import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createArmorer, createTool } from 'armorer';
import { z } from 'zod';

import type { Config } from '../config/schema';
import { runGit } from '../git/exec';
import { createWorktree, listWorktrees, removeWorktree } from '../git/worktree';
import { waitForCi } from '../github/ci';
import { openOrUpdatePr, requestReviewers } from '../github/pr';
import { fetchUnresolvedReviewComments, resolveReviewThread } from '../github/review';
import { fetchLinearTicket, moveLinearTicket } from '../linear/linear';
import { runVerifyCommands } from '../verify/run';

export type ToolPolicy = {
  repoRoot: string;
  worktreePath?: string;
  dryRun: boolean;
  allowDestructive: boolean;
};

export type ToolContext = ToolPolicy & {
  config: Config;
};

type ToolDefinition<TSchema extends z.ZodObject<z.ZodRawShape>> = {
  name: string;
  description: string;
  schema: TSchema;
  mutates?: boolean;
  execute: (params: z.infer<TSchema>, ctx: ToolContext) => Promise<unknown>;
};

const readOnlyHint = { mcp: { annotations: { readOnlyHint: true } } };

function ensureRepoPath(path: string, repoRoot: string): string {
  const resolved = resolve(repoRoot, path);
  if (!resolved.startsWith(repoRoot)) {
    throw new Error(`Path is outside allowed repo root: ${path}`);
  }
  return resolved;
}

async function guardTool<TSchema extends z.ZodObject<z.ZodRawShape>>(
  toolDef: ToolDefinition<TSchema>,
  params: z.infer<TSchema>,
  ctx: ToolContext,
): Promise<unknown> {
  if (toolDef.mutates) {
    if (ctx.dryRun) {
      throw new Error(`Tool ${toolDef.name} is not allowed in dry-run mode`);
    }
    if (!ctx.allowDestructive) {
      throw new Error(`Tool ${toolDef.name} is not allowed without --apply`);
    }
  }
  return toolDef.execute(params, ctx);
}

function toStructuredContent(result: unknown): Record<string, unknown> | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  if (Array.isArray(result)) return undefined;
  return result as Record<string, unknown>;
}

export function createToolRegistry(context: ToolContext) {
  const armorer = createArmorer([], { context });
  const sdkTools: Array<ReturnType<typeof sdkTool>> = [];
  const toolNames: string[] = [];
  const mutatingToolNames: string[] = [];

  const register = <TSchema extends z.ZodObject<z.ZodRawShape>>(
    definition: ToolDefinition<TSchema>,
  ): void => {
    const toolConfig = {
      name: definition.name,
      description: definition.description,
      schema: definition.schema.shape,
      metadata: definition.mutates ? {} : readOnlyHint,
      async execute(params: Record<string, unknown>) {
        return guardTool(definition, params as z.infer<TSchema>, context);
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
    if (definition.mutates) {
      mutatingToolNames.push(definition.name);
    }
  };

  register({
    name: 'fs.read',
    description: 'Read a file within the repository',
    schema: z.object({ path: z.string() }),
    async execute({ path }, ctx) {
      const target = ensureRepoPath(path, ctx.repoRoot);
      return await Bun.file(target).text();
    },
  });

  register({
    name: 'fs.write',
    description: 'Write a file within the repository',
    schema: z.object({ path: z.string(), content: z.string() }),
    mutates: true,
    async execute({ path, content }, ctx) {
      const target = ensureRepoPath(path, ctx.repoRoot);
      await Bun.write(target, content);
      return { ok: true };
    },
  });

  register({
    name: 'fs.patch',
    description: 'Apply a unified diff patch within the repository',
    schema: z.object({ patch: z.string() }),
    mutates: true,
    async execute({ patch }, ctx) {
      const proc = Bun.spawn(['git', 'apply', '--whitespace=nowarn', '-'], {
        cwd: ctx.repoRoot,
        stdin: 'pipe',
      });
      if (proc.stdin) {
        proc.stdin.write(patch);
        await proc.stdin.end();
      }
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(stderr.trim() || 'Failed to apply patch');
      }
      return { ok: true };
    },
  });

  register({
    name: 'git.status',
    description: 'Get git status for the worktree',
    schema: z.object({ cwd: z.string().optional() }),
    async execute({ cwd }, ctx) {
      const result = await runGit(['status', '--porcelain'], {
        cwd: cwd ? ensureRepoPath(cwd, ctx.repoRoot) : ctx.repoRoot,
        context: { runId: 'tool', repoRoot: ctx.repoRoot },
      });
      return { porcelain: result.stdout.trim() };
    },
  });

  register({
    name: 'git.diff',
    description: 'Get git diff for the worktree',
    schema: z.object({ cwd: z.string().optional() }),
    async execute({ cwd }, ctx) {
      const result = await runGit(['diff'], {
        cwd: cwd ? ensureRepoPath(cwd, ctx.repoRoot) : ctx.repoRoot,
        context: { runId: 'tool', repoRoot: ctx.repoRoot },
      });
      return { diff: result.stdout };
    },
  });

  register({
    name: 'git.commit',
    description: 'Commit staged changes',
    schema: z.object({ message: z.string() }),
    mutates: true,
    async execute({ message }, ctx) {
      await runGit(['add', '-A'], {
        cwd: ctx.repoRoot,
        context: { runId: 'tool', repoRoot: ctx.repoRoot },
      });
      const result = await runGit(['commit', '-m', message], {
        cwd: ctx.repoRoot,
        context: { runId: 'tool', repoRoot: ctx.repoRoot },
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || 'Failed to commit');
      }
      return { ok: true };
    },
  });

  register({
    name: 'git.push',
    description: 'Push current branch to origin',
    schema: z.object({ remote: z.string().optional(), branch: z.string().optional() }),
    mutates: true,
    async execute({ remote, branch }, ctx) {
      const args = ['push', remote ?? 'origin'];
      if (branch) args.push(branch);
      const result = await runGit(args, {
        cwd: ctx.repoRoot,
        context: { runId: 'tool', repoRoot: ctx.repoRoot },
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || 'Failed to push');
      }
      return { ok: true };
    },
  });

  register({
    name: 'git.worktree.list',
    description: 'List worktrees',
    schema: z.object({ includeStatus: z.boolean().optional() }),
    async execute({ includeStatus }, ctx) {
      return await listWorktrees({
        repoRoot: ctx.repoRoot,
        includeStatus: Boolean(includeStatus),
        context: { runId: 'tool', repoRoot: ctx.repoRoot },
      });
    },
  });

  register({
    name: 'git.worktree.create',
    description: 'Create a worktree and branch',
    schema: z.object({ name: z.string() }),
    mutates: true,
    async execute({ name }, ctx) {
      return await createWorktree({
        repoRoot: ctx.repoRoot,
        name,
        config: ctx.config,
        context: { runId: 'tool', repoRoot: ctx.repoRoot },
      });
    },
  });

  register({
    name: 'git.worktree.remove',
    description: 'Remove a worktree',
    schema: z.object({ path: z.string(), force: z.boolean().optional() }),
    mutates: true,
    async execute({ path, force }, ctx) {
      await removeWorktree({
        repoRoot: ctx.repoRoot,
        path: ensureRepoPath(path, ctx.repoRoot),
        force: Boolean(force),
        context: { runId: 'tool', repoRoot: ctx.repoRoot },
      });
      return { ok: true };
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
    mutates: true,
    async execute({ owner, repo, headBranch, baseBranch, title, body }) {
      return await openOrUpdatePr({
        owner,
        repo,
        headBranch,
        baseBranch,
        title,
        body,
        context: { runId: 'tool', repoRoot: context.repoRoot },
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
    mutates: true,
    async execute({ owner, repo, number, reviewers, requestCopilot }) {
      await requestReviewers({
        pr: { owner, repo, number },
        reviewers,
        requestCopilot: requestCopilot ?? true,
        context: { runId: 'tool', repoRoot: context.repoRoot },
      });
      return { ok: true };
    },
  });

  register({
    name: 'github.review.fetch',
    description: 'Fetch unresolved review threads',
    schema: z.object({ owner: z.string(), repo: z.string(), headBranch: z.string() }),
    async execute({ owner, repo, headBranch }) {
      return await fetchUnresolvedReviewComments({
        owner,
        repo,
        headBranch,
        context: { runId: 'tool', repoRoot: context.repoRoot },
      });
    },
  });

  register({
    name: 'github.review.resolve',
    description: 'Resolve a review thread',
    schema: z.object({ threadId: z.string() }),
    mutates: true,
    async execute({ threadId }) {
      return await resolveReviewThread({
        threadId,
        context: { runId: 'tool', repoRoot: context.repoRoot },
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
    async execute({ owner, repo, headBranch, pollIntervalMs, timeoutMs }, ctx) {
      return await waitForCi({
        owner,
        repo,
        headBranch,
        pollIntervalMs: pollIntervalMs ?? 15000,
        timeoutMs: timeoutMs ?? 900000,
        context: { runId: 'tool', repoRoot: ctx.repoRoot },
      });
    },
  });

  register({
    name: 'verify.run',
    description: 'Run configured verification commands',
    schema: z.object({ names: z.array(z.string()).optional() }),
    mutates: true,
    async execute({ names }, ctx) {
      return await runVerifyCommands(ctx.config, {
        ...(names ? { names } : {}),
        cwd: ctx.repoRoot,
      });
    },
  });

  register({
    name: 'linear.ticket.fetch',
    description: 'Fetch a Linear ticket',
    schema: z.object({ id: z.string() }),
    async execute({ id }) {
      return await fetchLinearTicket(id);
    },
  });

  register({
    name: 'linear.ticket.move',
    description: 'Move a Linear ticket to a new state',
    schema: z.object({ id: z.string(), state: z.string() }),
    mutates: true,
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
