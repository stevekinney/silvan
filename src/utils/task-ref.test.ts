import { describe, expect, it } from 'bun:test';

import { extractLinearTaskFromBranch } from './task-ref';

describe('extractLinearTaskFromBranch', () => {
  it('extracts a Linear task from a branch name', () => {
    const match = extractLinearTaskFromBranch('feature/ENG-42-add-tooling');
    expect(match).not.toBeNull();
    expect(match?.taskId).toBe('ENG-42');
    expect(match?.teamKey).toBe('ENG');
    expect(match?.taskNumber).toBe(42);
  });

  it('returns null when no Linear task is present', () => {
    expect(extractLinearTaskFromBranch('feature/no-ticket')).toBeNull();
  });
});
