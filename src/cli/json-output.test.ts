import { describe, expect, it } from 'bun:test';

import { SilvanError } from '../core/errors';
import { buildJsonError, formatCommandKey } from './json-output';

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
    const payload = buildJsonError(error);
    expect(payload.code).toBe('test.error');
    expect(payload.message).toBe('Something went wrong');
    expect(payload.details).toEqual({ id: 1 });
    expect(payload.suggestions).toEqual(['Retry the command.']);
  });
});
