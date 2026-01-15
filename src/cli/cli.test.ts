import { describe, expect, it } from 'bun:test';

import { sanitizeName } from '../utils/slug';

describe('cli helpers', () => {
  it('sanitizes names for worktrees', () => {
    expect(sanitizeName('Feature: Add Thing')).toBe('feature-add-thing');
  });
});
