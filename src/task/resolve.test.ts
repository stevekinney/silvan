import { describe, expect, it } from 'bun:test';

import type { Config } from '../config/schema';
import { parseTaskRef } from './resolve';

const baseConfig = {
  task: { providers: { enabled: ['linear', 'github'], default: 'linear' } },
} as Config;

describe('parseTaskRef', () => {
  it('parses Linear IDs', () => {
    const ref = parseTaskRef('DEP-10', baseConfig);
    expect(ref.provider).toBe('linear');
    expect(ref.id).toBe('DEP-10');
  });

  it('parses gh-123', () => {
    const ref = parseTaskRef('gh-123', baseConfig);
    expect(ref.provider).toBe('github');
    expect(ref.id).toBe('gh-123');
  });

  it('parses GitHub issue URLs', () => {
    const ref = parseTaskRef('https://github.com/acme/repo/issues/42', baseConfig);
    expect(ref.provider).toBe('github');
    expect(ref.owner).toBe('acme');
    expect(ref.repo).toBe('repo');
    expect(ref.number).toBe(42);
  });
});
