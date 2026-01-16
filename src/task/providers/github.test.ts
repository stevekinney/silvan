import { describe, expect, it } from 'bun:test';

import { fetchGitHubTask } from './github';

const octokit = {
  rest: {
    issues: {
      get: async () => ({
        data: {
          number: 123,
          title: 'Fix crash',
          body: `## Acceptance Criteria\n- handles null input\n- returns 200\n\n- [ ] add test\n- [x] update docs`,
          html_url: 'https://github.com/acme/repo/issues/123',
          labels: [{ name: 'type:bug' }, 'needs-tests'],
          assignee: { login: 'octocat' },
          state: 'open',
        },
      }),
    },
  },
} as const;

describe('fetchGitHubTask', () => {
  it('normalizes issue data into Task', async () => {
    const task = await fetchGitHubTask(
      { owner: 'acme', repo: 'repo', number: 123 },
      undefined,
      octokit as any,
    );
    expect(task.id).toBe('gh-123');
    expect(task.key).toBe('gh-123');
    expect(task.provider).toBe('github');
    expect(task.acceptanceCriteria).toContain('handles null input');
    expect(task.acceptanceCriteria).toContain('add test');
    expect(task.acceptanceCriteria).toContain('Label: type:bug');
    expect(task.labels).toContain('type:bug');
    expect(task.assignee).toBe('octocat');
    expect(task.state).toBe('open');
  });
});
