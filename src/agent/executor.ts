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

type ExecutionPolicy = {
  dryRun: boolean;
  allowDestructive: boolean;
  allowDangerous: boolean;
  toolBudget?: { maxCalls?: number; maxDurationMs?: number };
};

type ExecutionLimits = {
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
};

type ExecutionRuntime = {
  bus?: EventBus;
  context: EmitContext;
  state?: StateStore;
  sessionPool?: SessionPool;
  heartbeat?: () => Promise<void>;
  toolCallLog?: Array<{
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    resultDigest?: string;
    ok: boolean;
  }>;
};

export type ExecutorInput = {
  snapshot: ConversationSnapshot;
  model: string;
  repoRoot: string;
  config: Parameters<typeof createToolRegistry>[0]['config'];
  policy: ExecutionPolicy;
  runtime: ExecutionRuntime;
  limits?: ExecutionLimits;
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
  const { policy, runtime, limits } = input;

  const registry = registryFactory({
    repoRoot: input.repoRoot,
    config: input.config,
    dryRun: policy.dryRun,
    allowDestructive: policy.allowDestructive,
    allowDangerous: policy.allowDangerous,
    ...(policy.toolBudget ? { toolBudget: policy.toolBudget } : {}),
    emitContext: runtime.context,
    ...(runtime.bus ? { bus: runtime.bus } : {}),
    ...(runtime.state ? { state: runtime.state } : {}),
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
  if (runtime.bus) {
    await runtime.bus.emit(
      createEnvelope({
        type: 'ai.session_started',
        source: 'ai',
        level: 'info',
        context: runtime.context,
        payload: {
          model: { provider: 'anthropic', model: input.model },
          task: 'execute',
          allowedTools: allowedToolCount,
          ...(typeof limits?.maxTurns === 'number' ? { maxTurns: limits.maxTurns } : {}),
          ...(typeof limits?.maxBudgetUsd === 'number'
            ? { maxBudgetUsd: limits.maxBudgetUsd }
            : {}),
          ...(typeof limits?.maxThinkingTokens === 'number'
            ? { maxThinkingTokens: limits.maxThinkingTokens }
            : {}),
        },
      }),
    );
  }

  let result;
  try {
    const toolHooks = toolHooksFactory({
      ...(runtime.bus ? { bus: runtime.bus } : {}),
      context: runtime.context,
      ...(runtime.heartbeat ? { onHeartbeat: runtime.heartbeat } : {}),
      ...(runtime.toolCallLog
        ? {
            onToolCall: (entry) => {
              runtime.toolCallLog?.push(entry);
            },
          }
        : {}),
    });

    const permissionMode: ClaudeSessionOptions['permissionMode'] = policy.dryRun
      ? 'plan'
      : 'dontAsk';
    const toolGate = toolGateFactory({
      registry: registry.armorer,
      readOnly: policy.dryRun,
      allowMutation: policy.allowDestructive,
      allowDangerous: policy.allowDangerous && policy.allowDestructive && !policy.dryRun,
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
      ...(typeof limits?.maxTurns === 'number' ? { maxTurns: limits.maxTurns } : {}),
      ...(typeof limits?.maxBudgetUsd === 'number'
        ? { maxBudgetUsd: limits.maxBudgetUsd }
        : {}),
      ...(typeof limits?.maxThinkingTokens === 'number'
        ? { maxThinkingTokens: limits.maxThinkingTokens }
        : {}),
    };

    const session = runtime.sessionPool?.get('execute', sessionOptions);
    const runOptions = session
      ? { snapshot: input.snapshot, model: input.model, session }
      : { snapshot: input.snapshot, ...sessionOptions };
    result = await agentInvoker({
      ...runOptions,
      ...(runtime.bus ? { bus: runtime.bus } : {}),
      ...(runtime.context ? { context: runtime.context } : {}),
    });
  } finally {
    if (runtime.bus) {
      const durationMs = Math.round(performance.now() - start);
      await runtime.bus.emit(
        createEnvelope({
          type: 'ai.session_finished',
          source: 'ai',
          level: 'info',
          context: runtime.context,
          payload: {
            model: { provider: 'anthropic', model: input.model },
            task: 'execute',
            ok: result?.type === 'result' && result?.subtype === 'success',
            durationMs,
            ...(typeof runtime.toolCallLog?.length === 'number'
              ? { toolCalls: runtime.toolCallLog.length }
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
