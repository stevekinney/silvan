import type { ConversationSnapshot } from '../ai/conversation';
import { invokeAgent } from '../ai/router';
import type { EventBus } from '../events/bus';
import { createEnvelope, type EmitContext } from '../events/emit';
import type { StateStore } from '../state/store';
import { createClaudeToolGate } from './claude-adapter';
import { createToolRegistry } from './registry';
import type { ClaudeSessionOptions } from './sdk';
import { createToolHooks } from './sdk';
import type { SessionPool } from './session';

export type ExecutorInput = {
  snapshot: ConversationSnapshot;
  model: string;
  repoRoot: string;
  config: Parameters<typeof createToolRegistry>[0]['config'];
  dryRun: boolean;
  allowDestructive: boolean;
  allowDangerous: boolean;
  bus?: EventBus;
  context: EmitContext;
  state?: StateStore;
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
  toolBudget?: { maxCalls?: number; maxDurationMs?: number };
  sessionPool?: SessionPool;
  heartbeat?: () => Promise<void>;
  toolCallLog?: Array<{
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    resultDigest?: string;
    ok: boolean;
  }>;
  deps?: {
    createRegistry?: typeof createToolRegistry;
    createToolGate?: typeof createClaudeToolGate;
    createToolHooks?: typeof createToolHooks;
    invokeAgent?: typeof invokeAgent;
  };
};

export async function executePlan(input: ExecutorInput): Promise<string> {
  const registryFactory = input.deps?.createRegistry ?? createToolRegistry;
  const toolGateFactory = input.deps?.createToolGate ?? createClaudeToolGate;
  const toolHooksFactory = input.deps?.createToolHooks ?? createToolHooks;
  const agentInvoker = input.deps?.invokeAgent ?? invokeAgent;

  const registry = registryFactory({
    repoRoot: input.repoRoot,
    config: input.config,
    dryRun: input.dryRun,
    allowDestructive: input.allowDestructive,
    allowDangerous: input.allowDangerous,
    ...(input.toolBudget ? { toolBudget: input.toolBudget } : {}),
    emitContext: input.context,
    ...(input.bus ? { bus: input.bus } : {}),
    ...(input.state ? { state: input.state } : {}),
  });

  const builtinTools = {
    readOnly: ['read_file', 'list_directory', 'search_files', 'glob'],
    mutating: ['write_file', 'edit_file', 'create_file'],
    dangerous: ['bash'],
  };
  const allowedToolCount =
    registry.toolNames.length +
    builtinTools.readOnly.length +
    builtinTools.mutating.length +
    builtinTools.dangerous.length;

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
          task: 'execute',
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
    const toolHooks = toolHooksFactory({
      ...(input.bus ? { bus: input.bus } : {}),
      context: input.context,
      ...(input.heartbeat ? { onHeartbeat: input.heartbeat } : {}),
      ...(input.toolCallLog
        ? {
            onToolCall: (entry) => {
              input.toolCallLog?.push(entry);
            },
          }
        : {}),
    });

    const permissionMode: ClaudeSessionOptions['permissionMode'] = input.dryRun
      ? 'plan'
      : 'dontAsk';
    const toolGate = toolGateFactory({
      registry: registry.armorer,
      readOnly: input.dryRun,
      allowMutation: input.allowDestructive,
      allowDangerous: input.allowDangerous && input.allowDestructive && !input.dryRun,
      builtin: builtinTools,
      messages: {
        dangerous: 'Use --apply and --dangerous to allow this tool.',
      },
    });
    const canUseTool: ClaudeSessionOptions['canUseTool'] = async (toolName) => {
      const decision = await toolGate(toolName);
      if (decision.behavior === 'allow') {
        return { behavior: 'allow' };
      }
      return {
        behavior: 'deny',
        message: decision.message ?? `Tool not allowed: ${toolName}`,
      };
    };

    const sessionOptions: ClaudeSessionOptions = {
      model: input.model,
      permissionMode,
      mcpServers: { 'silvan-tools': registry.sdkServer },
      canUseTool,
      hooks: toolHooks,
      ...(typeof input.maxTurns === 'number' ? { maxTurns: input.maxTurns } : {}),
      ...(typeof input.maxBudgetUsd === 'number'
        ? { maxBudgetUsd: input.maxBudgetUsd }
        : {}),
      ...(typeof input.maxThinkingTokens === 'number'
        ? { maxThinkingTokens: input.maxThinkingTokens }
        : {}),
    };

    const session = input.sessionPool?.get('execute', sessionOptions);
    const runOptions = session
      ? { snapshot: input.snapshot, model: input.model, session }
      : { snapshot: input.snapshot, ...sessionOptions };
    result = await agentInvoker({
      ...runOptions,
      ...(input.bus ? { bus: input.bus } : {}),
      ...(input.context ? { context: input.context } : {}),
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
            task: 'execute',
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
