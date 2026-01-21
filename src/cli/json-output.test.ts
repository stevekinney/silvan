import { describe, expect, it } from 'bun:test';

import { SilvanError } from '../core/errors';
import { EventBus } from '../events/bus';
import {
  buildJsonError,
  emitJsonError,
  emitJsonResult,
  emitJsonSuccess,
  formatCommandKey,
} from './json-output';

describe('json output helpers', () => {
  it('formats command keys', () => {
    expect(formatCommandKey('run list')).toBe('run.list');
  });

  it('builds JSON error payloads', () => {
    const error = new SilvanError({
      code: 'test.error',
      message: 'Internal failure',
      userMessage: 'Something went wrong',
      nextSteps: ['Retry the command.'],
      details: { id: 1 },
    });
    const payload = buildJsonError(error, {
      assistant: {
        summary: 'Review your configuration.',
        steps: ['Run `silvan config validate`.'],
      },
    });
    expect(payload.code).toBe('test.error');
    expect(payload.message).toBe('Something went wrong');
    expect(payload.details).toEqual({
      id: 1,
      assistant: {
        summary: 'Review your configuration.',
        steps: ['Run `silvan config validate`.'],
      },
    });
    expect(payload.suggestions).toEqual([
      'Retry the command.',
      'Run `silvan config validate`.',
    ]);
  });

  it('emits json results to the bus when provided', async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const bus = new EventBus();
    const unsub = bus.subscribe((event) => {
      events.push(event as { type: string; payload: unknown });
    });
    await emitJsonResult({
      command: 'run list',
      data: { ok: true },
      bus,
    });
    unsub();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('cli.result');
  });

  it('respects SILVAN_QUIET for success output', async () => {
    const original = process.env['SILVAN_QUIET'];
    process.env['SILVAN_QUIET'] = '1';
    const logSpy = console.log;
    let called = false;
    console.log = () => {
      called = true;
    };
    await emitJsonSuccess({ command: 'doctor', data: { ok: true } });
    console.log = logSpy;
    if (original === undefined) {
      delete process.env['SILVAN_QUIET'];
    } else {
      process.env['SILVAN_QUIET'] = original;
    }
    expect(called).toBe(false);
  });

  it('emits json errors with assistant context', async () => {
    const logSpy = console.log;
    let output = '';
    console.log = (value) => {
      output = String(value);
    };
    await emitJsonError({
      command: 'task start',
      error: new SilvanError({
        code: 'task.fail',
        message: 'Failure',
        userMessage: 'Failure',
      }),
      assistant: { summary: 'Try again', steps: ['Retry'] },
    });
    console.log = logSpy;
    expect(output).toContain('"success":false');
    expect(output).toContain('assistant');
  });
});
