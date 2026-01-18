import { describe, expect, it } from 'bun:test';

import {
  formatRelativeTime,
  renderRunListMinimal,
  renderRunListTable,
  type RunListEntry,
} from './run-list-output';

describe('run list output helpers', () => {
  it('formats relative timestamps', () => {
    const now = Date.parse('2025-01-15T12:00:00Z');
    expect(formatRelativeTime('2025-01-15T11:59:45Z', now)).toBe('just now');
    expect(formatRelativeTime('2025-01-15T11:58:00Z', now)).toBe('2 min ago');
    expect(formatRelativeTime('2025-01-15T10:00:00Z', now)).toBe('2 hours ago');
    expect(formatRelativeTime('2025-01-13T12:00:00Z', now)).toBe('2 days ago');
  });

  it('renders minimal output', () => {
    const runs: RunListEntry[] = [
      {
        runId: 'abc123456789',
        status: 'running',
        phase: 'plan',
        taskTitle: 'Add login form',
      },
    ];
    const output = renderRunListMinimal(runs);
    expect(output).toContain('abc12345 running plan Add login form');
  });

  it('renders table output with legend', () => {
    const runs: RunListEntry[] = [
      {
        runId: 'abc123456789',
        status: 'running',
        phase: 'plan',
        taskTitle: 'Add login form',
        updatedAt: '2025-01-15T11:59:45Z',
      },
    ];
    const output = renderRunListTable(runs, {
      total: 1,
      filteredTotal: 1,
      showing: 1,
      limit: 20,
      offset: 0,
      showSource: false,
    });
    expect(output).toContain('Runs (1 total)');
    expect(output).toContain('ID');
    expect(output).toContain('Legend: Running, Blocked, Success, Failed');
  });
});
