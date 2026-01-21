import { createArmorer, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  createClaudeAgentSdkServer,
  createClaudeToolGate,
  toClaudeAgentSdkTools,
} from './claude-adapter';

function createTestTool(options: {
  name: string;
  result?: unknown;
  throwError?: boolean;
  metadata?: { mutates?: boolean; dangerous?: boolean; readOnly?: boolean };
  tags?: string[];
}) {
  const armorer = createArmorer([], {
    context: {},
    telemetry: false,
    digests: { input: false, output: false },
    outputValidationMode: 'report',
    readOnly: false,
    allowMutation: true,
  });
  const tool = createTool(
    {
      name: options.name,
      description: 'Test tool',
      schema: z.object({}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      tags: options.tags ?? [],
      async execute() {
        if (options.throwError) {
          throw new Error('Boom');
        }
        return options.result ?? { ok: true };
      },
    },
    armorer,
  );
  return { tool, armorer };
}

describe('toClaudeAgentSdkTools', () => {
  it('maps tool execution results into SDK output', async () => {
    const { tool } = createTestTool({ name: 'ok-tool', result: { ok: true } });
    const [sdkTool] = toClaudeAgentSdkTools(tool);
    if (!sdkTool) throw new Error('Expected SDK tool');
    const result = await sdkTool.handler({}, {});
    const textBlock = result.content?.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Expected text content');
    }
    expect(textBlock.text).toContain('{');
    expect(result.structuredContent).toEqual({ ok: true });
  });

  it('maps tool errors into SDK error output', async () => {
    const { tool } = createTestTool({ name: 'error-tool', throwError: true });
    const [sdkTool] = toClaudeAgentSdkTools(tool);
    if (!sdkTool) throw new Error('Expected SDK tool');
    const result = await sdkTool.handler({}, {});
    expect(result.isError).toBe(true);
  });
});

describe('createClaudeAgentSdkServer', () => {
  it('collects tool metadata', () => {
    const { tool } = createTestTool({
      name: 'mutating-tool',
      metadata: { mutates: true },
    });
    const server = createClaudeAgentSdkServer(tool, { name: 'test' });
    expect(server.toolNames).toContain('mutating-tool');
    expect(server.mutatingToolNames).toContain('mutating-tool');
  });
});

describe('createClaudeToolGate', () => {
  it('denies mutating tools when read-only', async () => {
    const { tool } = createTestTool({
      name: 'mutating-tool',
      metadata: { mutates: true },
    });
    const gate = createClaudeToolGate({
      registry: tool,
      readOnly: true,
    });
    const decision = await gate('mutating-tool');
    expect(decision.behavior).toBe('deny');
  });

  it('denies dangerous tools when not allowed', async () => {
    const { tool } = createTestTool({
      name: 'danger-tool',
      metadata: { dangerous: true },
    });
    const gate = createClaudeToolGate({
      registry: tool,
      allowDangerous: false,
    });
    const decision = await gate('danger-tool');
    expect(decision.behavior).toBe('deny');
  });

  it('allows unknown tools when configured', async () => {
    const { tool } = createTestTool({ name: 'ok-tool' });
    const gate = createClaudeToolGate({
      registry: tool,
      allowUnknown: true,
    });
    const decision = await gate('unknown-tool');
    expect(decision.behavior).toBe('allow');
  });
});
