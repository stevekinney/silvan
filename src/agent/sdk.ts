import type {
  HookCallbackMatcher,
  SDKResultMessage,
  SDKSessionOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { unstable_v2_prompt } from '@anthropic-ai/claude-agent-sdk';

import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { hashString } from '../utils/hash';

export type ClaudeRunOptions = {
  message: string;
  model: string;
  mcpServers?: Record<string, unknown>;
  permissionMode?: SDKSessionOptions['permissionMode'];
  allowedTools?: string[];
  disallowedTools?: string[];
  hooks?: SDKSessionOptions['hooks'];
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
};

export async function runClaudePrompt(
  options: ClaudeRunOptions,
): Promise<SDKResultMessage> {
  const promptOptions: SDKSessionOptions & {
    mcpServers?: Record<string, unknown>;
    maxTurns?: number;
    maxBudgetUsd?: number;
    maxThinkingTokens?: number;
  } = {
    model: options.model,
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(typeof options.maxTurns === 'number' ? { maxTurns: options.maxTurns } : {}),
    ...(typeof options.maxBudgetUsd === 'number'
      ? { maxBudgetUsd: options.maxBudgetUsd }
      : {}),
    ...(typeof options.maxThinkingTokens === 'number'
      ? { maxThinkingTokens: options.maxThinkingTokens }
      : {}),
  };

  return unstable_v2_prompt(options.message, promptOptions);
}

export function createToolHooks(options: {
  bus?: EventBus;
  context: EmitContext;
  onToolCall?: (entry: {
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    resultDigest?: string;
    ok: boolean;
  }) => void;
}): Partial<Record<string, HookCallbackMatcher[]>> {
  if (!options.bus) return {};

  const preToolUse: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true };
        const argsDigest = hashString(JSON.stringify(input.tool_input ?? {}));
        await options.bus?.emit(
          createEnvelope({
            type: 'ai.tool_call_started',
            source: 'ai',
            level: 'info',
            context: options.context,
            payload: {
              toolCallId: input.tool_use_id,
              toolName: input.tool_name,
              argsDigest,
            },
          }),
        );
        return { continue: true };
      },
    ],
  };

  const postToolUse: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PostToolUse') return { continue: true };
        const resultDigest = hashString(JSON.stringify(input.tool_response ?? {}));
        await options.bus?.emit(
          createEnvelope({
            type: 'ai.tool_call_finished',
            source: 'ai',
            level: 'info',
            context: options.context,
            payload: {
              toolCallId: input.tool_use_id,
              ok: true,
              resultDigest,
            },
          }),
        );
        options.onToolCall?.({
          toolCallId: input.tool_use_id,
          toolName: input.tool_name,
          argsDigest: hashString(JSON.stringify(input.tool_input ?? {})),
          resultDigest,
          ok: true,
        });
        return { continue: true };
      },
    ],
  };

  const postToolUseFailure: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PostToolUseFailure') return { continue: true };
        await options.bus?.emit(
          createEnvelope({
            type: 'ai.tool_call_finished',
            source: 'ai',
            level: 'error',
            context: options.context,
            payload: {
              toolCallId: input.tool_use_id,
              ok: false,
              error: { message: input.error ?? 'Tool call failed' },
            },
          }),
        );
        options.onToolCall?.({
          toolCallId: input.tool_use_id,
          toolName: input.tool_name,
          argsDigest: hashString(JSON.stringify(input.tool_input ?? {})),
          ok: false,
        });
        return { continue: true };
      },
    ],
  };

  return {
    PreToolUse: [preToolUse],
    PostToolUse: [postToolUse],
    PostToolUseFailure: [postToolUseFailure],
  };
}
