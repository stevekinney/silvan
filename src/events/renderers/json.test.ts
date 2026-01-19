import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { createEnvelope, type EmitContext } from '../emit';
import { JsonRenderer } from './json';

const context: EmitContext = {
  runId: 'run-1',
  repoRoot: '/tmp/repo',
  mode: 'json',
};

const makeEvent = (level: 'debug' | 'info' | 'warn' | 'error') =>
  createEnvelope({
    type: 'log.message',
    source: 'cli',
    level,
    context,
    payload: { message: 'hello' },
  });

describe('JsonRenderer', () => {
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    envSnapshot['SILVAN_DEBUG'] = process.env['SILVAN_DEBUG'];
    envSnapshot['SILVAN_QUIET'] = process.env['SILVAN_QUIET'];
    envSnapshot['SILVAN_JSON'] = process.env['SILVAN_JSON'];
    delete process.env['SILVAN_DEBUG'];
    delete process.env['SILVAN_QUIET'];
    delete process.env['SILVAN_JSON'];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('suppresses debug events unless verbose is enabled', () => {
    const renderer = new JsonRenderer();
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    renderer.render(makeEvent('debug'));
    expect(logSpy).toHaveBeenCalledTimes(0);

    process.env['SILVAN_DEBUG'] = '1';
    renderer.render(makeEvent('debug'));
    expect(logSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it('suppresses non-errors in quiet mode', () => {
    process.env['SILVAN_QUIET'] = '1';
    const renderer = new JsonRenderer();
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    renderer.render(makeEvent('info'));
    renderer.render(makeEvent('error'));
    expect(logSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });
});
