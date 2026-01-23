import type {
  McpSdkServerConfigWithInstance,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Armorer } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversation } from 'conversationalist';

import type { ConversationSnapshot } from '../ai/conversation';
import { configSchema } from '../config/schema';
import { executePlan } from './executor';

function buildSnapshot(): ConversationSnapshot {
  return {
    conversation: createConversation({ title: 'Test' }),
    digest: 'digest',
    updatedAt: new Date().toISOString(),
    path: 'memory',
  };
}

describe('executePlan', () => {
  it('returns the agent result when successful', async () => {
    const config = configSchema.parse({});
    const result = await executePlan({
      snapshot: buildSnapshot(),
      model: 'test',
      repoRoot: '/tmp',
      config,
      policy: {
        dryRun: true,
        allowDestructive: false,
        allowDangerous: false,
      },
      runtime: { context: { runId: 'run-1', repoRoot: '/tmp' } },
      deps: {
        createRegistry: (_context) =>
          ({
            armorer: {} as Armorer,
            sdkServer: {
              type: 'sdk',
              name: 'test',
              instance: {},
            } as unknown as McpSdkServerConfigWithInstance,
            toolNames: ['tool-1'],
            mutatingToolNames: [] as string[],
            dangerousToolNames: [] as string[],
          }) satisfies ReturnType<typeof import('./registry').createToolRegistry>,
        createToolGate: () => async () => ({ behavior: 'allow' }),
        createToolHooks: () => ({}),
        invokeAgent: async () =>
          ({
            type: 'result',
            subtype: 'success',
            result: 'done',
          }) as unknown as SDKResultMessage,
      },
    });
    expect(result).toBe('done');
  });

  it('throws when the agent result is not successful', async () => {
    const config = configSchema.parse({});
    return expect(
      executePlan({
        snapshot: buildSnapshot(),
        model: 'test',
        repoRoot: '/tmp',
        config,
        policy: {
          dryRun: true,
          allowDestructive: false,
          allowDangerous: false,
        },
        runtime: { context: { runId: 'run-2', repoRoot: '/tmp' } },
        deps: {
          createRegistry: (_context) =>
            ({
              armorer: {} as Armorer,
              sdkServer: {
                type: 'sdk',
                name: 'test',
                instance: {},
              } as unknown as McpSdkServerConfigWithInstance,
              toolNames: [],
              mutatingToolNames: [] as string[],
              dangerousToolNames: [] as string[],
            }) satisfies ReturnType<typeof import('./registry').createToolRegistry>,
          createToolGate: () => async () => ({ behavior: 'allow' }),
          createToolHooks: () => ({}),
          invokeAgent: async () =>
            ({
              type: 'result',
              subtype: 'error',
              result: 'fail',
            }) as unknown as SDKResultMessage,
        },
      }),
    ).rejects.toThrow('Executor failed');
  });
});
