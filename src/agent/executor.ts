import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createToolRegistry } from './registry';
import type { Plan } from './schemas';
import { createToolHooks, runClaudePrompt } from './sdk';

export type ExecutorInput = {
  plan: Plan;
  model: string;
  repoRoot: string;
  config: Parameters<typeof createToolRegistry>[0]['config'];
  dryRun: boolean;
  allowDestructive: boolean;
  bus?: EventBus;
  context: EmitContext;
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
  toolCallLog?: Array<{
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    resultDigest?: string;
    ok: boolean;
  }>;
};

export async function executePlan(input: ExecutorInput): Promise<string> {
  const registry = createToolRegistry({
    repoRoot: input.repoRoot,
    config: input.config,
    dryRun: input.dryRun,
    allowDestructive: input.allowDestructive,
    emitContext: input.context,
    ...(input.bus ? { bus: input.bus } : {}),
  });

  const allowedTools = input.dryRun
    ? registry.toolNames.filter((name) => !registry.mutatingToolNames.includes(name))
    : registry.toolNames;

  const prompt = [
    'You are the implementation agent for Silvan.',
    'Follow the plan step-by-step, using tools when needed.',
    'Do not invent file contents; use fs.read before edits.',
    'Keep changes minimal and aligned to the plan.',
    'Return a brief summary of changes.',
    '',
    'Plan JSON:',
    JSON.stringify(input.plan, null, 2),
  ].join('\n');

  const result = await runClaudePrompt({
    message: prompt,
    model: input.model,
    permissionMode: 'dontAsk',
    mcpServers: { 'silvan-tools': registry.sdkServer },
    allowedTools,
    hooks: createToolHooks({
      ...(input.bus ? { bus: input.bus } : {}),
      context: input.context,
      ...(input.toolCallLog
        ? {
            onToolCall: (entry) => {
              input.toolCallLog?.push(entry);
            },
          }
        : {}),
    }),
    ...(typeof input.maxTurns === 'number' ? { maxTurns: input.maxTurns } : {}),
    ...(typeof input.maxBudgetUsd === 'number'
      ? { maxBudgetUsd: input.maxBudgetUsd }
      : {}),
    ...(typeof input.maxThinkingTokens === 'number'
      ? { maxThinkingTokens: input.maxThinkingTokens }
      : {}),
  });

  if (result.type !== 'result' || result.subtype !== 'success') {
    throw new Error(`Executor failed: ${result.subtype}`);
  }

  return result.result;
}
