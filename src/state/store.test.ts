import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { initStateStore } from './store';

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-state-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('state store', () => {
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    envSnapshot['SILVAN_JSON'] = process.env['SILVAN_JSON'];
    envSnapshot['SILVAN_QUIET'] = process.env['SILVAN_QUIET'];
    delete process.env['SILVAN_JSON'];
    delete process.env['SILVAN_QUIET'];
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

  it('emits the global notice in interactive mode', async () => {
    await withTempRoot(async (root) => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      await initStateStore('/repo', { mode: 'global', root, lock: false });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  it('suppresses the global notice in json mode', async () => {
    process.env['SILVAN_JSON'] = '1';
    await withTempRoot(async (root) => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      await initStateStore('/repo', { mode: 'global', root, lock: false });
      expect(warnSpy).toHaveBeenCalledTimes(0);
      warnSpy.mockRestore();
    });
  });

  it('suppresses the global notice in quiet mode', async () => {
    process.env['SILVAN_QUIET'] = '1';
    await withTempRoot(async (root) => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      await initStateStore('/repo', { mode: 'global', root, lock: false });
      expect(warnSpy).toHaveBeenCalledTimes(0);
      warnSpy.mockRestore();
    });
  });
});
