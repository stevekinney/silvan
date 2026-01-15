import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
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
  allowDangerous: boolean;
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
    allowDangerous: input.allowDangerous,
    emitContext: input.context,
    ...(input.bus ? { bus: input.bus } : {}),
  });

  const readOnlyBuiltinTools = new Set([
    'read_file',
    'list_directory',
    'search_files',
    'glob',
  ]);
  const writeBuiltinTools = new Set(['write_file', 'edit_file', 'create_file']);
  const allowedToolCount =
    registry.toolNames.length + readOnlyBuiltinTools.size + writeBuiltinTools.size;

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

  const start = performance.now();
  if (input.bus) {
    await input.bus.emit(
      createEnvelope({
        type: 'ai.session_started',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          model: { provider: 'anthropic', model: input.model },
          allowedTools: allowedToolCount,
          ...(typeof input.maxTurns === 'number' ? { maxTurns: input.maxTurns } : {}),
          ...(typeof input.maxBudgetUsd === 'number'
            ? { maxBudgetUsd: input.maxBudgetUsd }
            : {}),
          ...(typeof input.maxThinkingTokens === 'number'
            ? { maxThinkingTokens: input.maxThinkingTokens }
            : {}),
        },
      }),
    );
  }

  let result;
  try {
    result = await runClaudePrompt({
      message: prompt,
      model: input.model,
      permissionMode: input.dryRun ? 'plan' : 'dontAsk',
      mcpServers: { 'silvan-tools': registry.sdkServer },
      canUseTool: (toolName) => {
        if (registry.toolNames.includes(toolName)) {
          if (input.dryRun && registry.mutatingToolNames.includes(toolName)) {
            return Promise.resolve({
              behavior: 'deny',
              message: 'Dry-run mode: mutating tools disabled.',
            });
          }
          if (!input.allowDestructive && registry.mutatingToolNames.includes(toolName)) {
            return Promise.resolve({
              behavior: 'deny',
              message: 'Use --apply to allow mutating tools.',
            });
          }
          return Promise.resolve({ behavior: 'allow' });
        }
        if (readOnlyBuiltinTools.has(toolName)) {
          return Promise.resolve({ behavior: 'allow' });
        }
        if (writeBuiltinTools.has(toolName)) {
          if (input.dryRun || !input.allowDestructive) {
            return Promise.resolve({
              behavior: 'deny',
              message: 'Use --apply to allow file edits.',
            });
          }
          return Promise.resolve({ behavior: 'allow' });
        }
        return Promise.resolve({
          behavior: 'deny',
          message: `Tool not allowed: ${toolName}`,
        });
      },
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
  } finally {
    if (input.bus) {
      const durationMs = Math.round(performance.now() - start);
      await input.bus.emit(
        createEnvelope({
          type: 'ai.session_finished',
          source: 'ai',
          level: 'info',
          context: input.context,
          payload: {
            model: { provider: 'anthropic', model: input.model },
            ok: result?.type === 'result' && result?.subtype === 'success',
            durationMs,
            ...(typeof input.toolCallLog?.length === 'number'
              ? { toolCalls: input.toolCallLog.length }
              : {}),
          },
        }),
      );
    }
  }

  if (result.type !== 'result' || result.subtype !== 'success') {
    throw new Error(`Executor failed: ${result.subtype}`);
  }

  return result.result;
}
