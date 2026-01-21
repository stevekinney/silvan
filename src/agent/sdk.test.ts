import type { SDKResultMessage, SDKSession } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'bun:test';

import { EventBus } from '../events/bus';
import { createToolHooks, runClaudePrompt } from './sdk';

describe('runClaudePrompt', () => {
  it('returns the result from an injected session', async () => {
    let closed = false;
    const session = {
      sessionId: 'session-1',
      send: async () => {},
      async *stream() {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
        } as unknown as SDKResultMessage;
      },
      close: () => {
        closed = true;
      },
      [Symbol.asyncDispose]: async () => {},
    } as SDKSession;

    const result = await runClaudePrompt({
      message: 'hi',
      model: 'test',
      session,
    });
    if (result.type !== 'result' || result.subtype !== 'success') {
      throw new Error('Expected success result');
    }
    expect(result.result).toBe('ok');
    expect(closed).toBe(false);
  });

  it('throws when no result is produced', async () => {
    let closed = false;
    const session = {
      sessionId: 'session-2',
      send: async () => {},
      async *stream() {
        yield { type: 'event' } as unknown as SDKResultMessage;
      },
      close: () => {
        closed = true;
      },
      [Symbol.asyncDispose]: async () => {},
    } as SDKSession;

    const error = await runClaudePrompt({
      message: 'hi',
      model: 'test',
      session,
    }).then(
      () => undefined,
      (err) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe('Claude session ended without a result');
    expect(closed).toBe(false);
  });
});

describe('createToolHooks', () => {
  it('emits tool call events through the bus', async () => {
    const events: Array<{ type: string }> = [];
    const bus = new EventBus();
    const unsub = bus.subscribe((event) => {
      events.push(event);
    });
    const toolCalls: Array<{ toolCallId: string; ok: boolean }> = [];
    const hooks = createToolHooks({
      bus,
      context: { runId: 'run-1', repoRoot: '/tmp' },
      onToolCall: (entry) => {
        toolCalls.push({ toolCallId: entry.toolCallId, ok: entry.ok });
      },
    });

    const pre = hooks['PreToolUse']?.[0]?.hooks?.[0];
    await pre?.(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session-1',
        transcript_path: '/tmp/claude.log',
        cwd: '/tmp',
        tool_use_id: 'tool-1',
        tool_name: 'test',
        tool_input: { a: 1 },
      },
      'tool-1',
      { signal: new AbortController().signal },
    );

    const post = hooks['PostToolUse']?.[0]?.hooks?.[0];
    await post?.(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'session-1',
        transcript_path: '/tmp/claude.log',
        cwd: '/tmp',
        tool_use_id: 'tool-1',
        tool_name: 'test',
        tool_response: { ok: true },
        tool_input: { a: 1 },
      },
      'tool-1',
      { signal: new AbortController().signal },
    );

    const fail = hooks['PostToolUseFailure']?.[0]?.hooks?.[0];
    await fail?.(
      {
        hook_event_name: 'PostToolUseFailure',
        session_id: 'session-1',
        transcript_path: '/tmp/claude.log',
        cwd: '/tmp',
        tool_use_id: 'tool-2',
        tool_name: 'test',
        tool_input: {},
        error: 'fail',
      },
      'tool-2',
      { signal: new AbortController().signal },
    );

    expect(events.length).toBeGreaterThan(0);
    expect(toolCalls).toHaveLength(2);
    unsub();
  });
});
