import { describe, expect, it } from 'bun:test';

import { renderWorktreeListTable, type WorktreeListEntry } from './worktree-list-output';

describe('worktree list output helpers', () => {
  it('renders table output with legend', () => {
    const worktrees: WorktreeListEntry[] = [
      {
        path: '/repo',
        branch: 'main',
        headSha: 'abc123456789',
      },
      {
        path: '/repo/.worktrees/feature',
        branch: 'feature/add-output',
        headSha: 'def987654321',
        isDirty: true,
      },
    ];

    const output = renderWorktreeListTable(worktrees, { total: 2 });
    expect(output).toContain('Worktrees (2 total)');
    expect(output).toContain('Status');
    expect(output).toContain('Branch');
    expect(output).toContain('Path');
    expect(output).toContain('Head');
    expect(output).toContain('Legend: Clean, Dirty, Locked, Bare, Detached');
    expect(output).toContain('Dirty');
  });
});
