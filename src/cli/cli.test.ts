import { describe, expect, it } from 'bun:test';

import { sanitizeName } from '../utils/slug';
import { buildWorktreeName } from '../utils/worktree-name';

describe('cli helpers', () => {
  it('sanitizes names for worktrees', () => {
    expect(sanitizeName('Feature: Add Thing')).toBe('feature-add-thing');
  });

  it('builds worktree names from task key and title', () => {
    const name = buildWorktreeName({
      id: 'task-1',
      key: 'ENG-123',
      provider: 'linear',
      title: 'Improve Run Status Visibility',
      description: '',
      acceptanceCriteria: [],
      labels: [],
    });
    expect(name).toBe('eng-123-improve-run-status-visibility-h8df6a9');
  });
});
