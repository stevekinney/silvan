import type { SDKSessionOptions } from '@anthropic-ai/claude-agent-sdk';
import { ProseWriter } from 'prose-writer';

import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import type { StateStore } from '../state/store';
import { createToolRegistry } from './registry';
import { createToolHooks, runClaudePrompt } from './sdk';
import type { SessionPool } from './session';

export type ExecutorInput = {
  planDigest?: string;
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
};

export async function executePlan(input: ExecutorInput): Promise<string> {
  const registry = createToolRegistry({
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

  const readOnlyBuiltinTools = new Set([
    'read_file',
    'list_directory',
    'search_files',
    'glob',
  ]);
  const writeBuiltinTools = new Set(['write_file', 'edit_file', 'create_file']);
  const execBuiltinTools = new Set(['bash']);
  const allowedToolCount =
    registry.toolNames.length +
    readOnlyBuiltinTools.size +
    writeBuiltinTools.size +
    execBuiltinTools.size;

  const promptWriter = new ProseWriter();
  promptWriter.write('You are the implementation agent for Silvan.');
  promptWriter.write('Follow the plan step-by-step, using tools when needed.');
  promptWriter.write('Do not invent file contents; use fs.read before edits.');
  promptWriter.write('Keep changes minimal and aligned to the plan.');
  promptWriter.write('Use silvan.plan.read to fetch the full plan before making edits.');
  promptWriter.write('Use silvan.task.read to fetch the task details as needed.');
  promptWriter.write('Return a brief summary of changes.');
  promptWriter.write('Plan digest:');
  promptWriter.write(input.planDigest ?? 'unknown');
  const prompt = promptWriter.toString().trimEnd();

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
    const toolHooks = createToolHooks({
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

    const permissionMode: SDKSessionOptions['permissionMode'] = input.dryRun
      ? 'plan'
      : 'dontAsk';
    const allow = { behavior: 'allow' } as const;
    const deny = (message: string) => ({ behavior: 'deny', message }) as const;
    const canUseTool: SDKSessionOptions['canUseTool'] = (toolName) => {
      if (registry.toolNames.includes(toolName)) {
        if (input.dryRun && registry.mutatingToolNames.includes(toolName)) {
          return Promise.resolve(deny('Dry-run mode: mutating tools disabled.'));
        }
        if (!input.allowDestructive && registry.mutatingToolNames.includes(toolName)) {
          return Promise.resolve(deny('Use --apply to allow mutating tools.'));
        }
        return Promise.resolve(allow);
      }
      if (readOnlyBuiltinTools.has(toolName)) {
        return Promise.resolve(allow);
      }
      if (writeBuiltinTools.has(toolName)) {
        if (input.dryRun || !input.allowDestructive) {
          return Promise.resolve(deny('Use --apply to allow file edits.'));
        }
        return Promise.resolve(allow);
      }
      if (execBuiltinTools.has(toolName)) {
        if (input.dryRun || !input.allowDestructive || !input.allowDangerous) {
          return Promise.resolve(
            deny('Use --apply and --dangerous to allow command execution.'),
          );
        }
        return Promise.resolve(allow);
      }
      return Promise.resolve(deny(`Tool not allowed: ${toolName}`));
    };

    const sessionOptions = {
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
      ? { message: prompt, model: input.model, session }
      : { message: prompt, ...sessionOptions };
    result = await runClaudePrompt(runOptions);
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
