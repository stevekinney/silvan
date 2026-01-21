import { describe, expect, it } from 'bun:test';
import type { Octokit } from 'octokit';

import { getCiStatus, waitForCi } from './ci';

function createOctokitStub(options: {
  pulls?: Array<{ number: number; html_url?: string; head: { sha: string } }>;
  checkRuns?: Array<{
    name: string;
    status: 'completed' | 'in_progress' | 'queued';
    conclusion?: string | null;
    html_url?: string | null;
  }>;
}): Octokit {
  const pulls = options.pulls ?? [];
  const checkRuns = options.checkRuns ?? [];
  return {
    rest: {
      pulls: {
        list: async () => ({ data: pulls }),
      },
      checks: {
        listForRef: async () => ({ data: { check_runs: checkRuns } }),
      },
    },
  } as unknown as Octokit;
}

describe('getCiStatus', () => {
  it('maps check runs into CI status', async () => {
    const octokit = createOctokitStub({
      checkRuns: [
        {
          name: 'lint',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://example.com/check',
        },
        { name: 'test', status: 'in_progress', conclusion: null },
      ],
    });
    const result = await getCiStatus({
      owner: 'acme',
      repo: 'repo',
      headSha: 'sha-1',
      pr: { owner: 'acme', repo: 'repo', number: 1 },
      octokit,
      context: { runId: 'run-1', repoRoot: '/tmp' },
    });
    expect(result.state).toBe('pending');
    expect(result.checks).toHaveLength(2);
    expect(result.checks?.[0]?.name).toBe('lint');
  });
});

describe('waitForCi', () => {
  it('returns when CI passes', async () => {
    const octokit = createOctokitStub({
      pulls: [
        {
          number: 7,
          html_url: 'https://example.com/pr/7',
          head: { sha: 'sha-7' },
        },
      ],
      checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    });
    const result = await waitForCi({
      owner: 'acme',
      repo: 'repo',
      headBranch: 'feature/test',
      octokit,
      pollIntervalMs: 0,
      timeoutMs: 1000,
      sleep: async () => {},
      context: { runId: 'run-2', repoRoot: '/tmp' },
    });
    expect(result.state).toBe('passing');
    expect(result.pr.number).toBe(7);
  });

  it('throws on timeout', async () => {
    const octokit = createOctokitStub({
      pulls: [
        {
          number: 2,
          html_url: 'https://example.com/pr/2',
          head: { sha: 'sha-2' },
        },
      ],
      checkRuns: [{ name: 'test', status: 'in_progress', conclusion: null }],
    });
    return expect(
      waitForCi({
        owner: 'acme',
        repo: 'repo',
        headBranch: 'feature/test',
        octokit,
        pollIntervalMs: 0,
        timeoutMs: 0,
        sleep: async () => {},
        context: { runId: 'run-3', repoRoot: '/tmp' },
      }),
    ).rejects.toThrow('Timed out');
  });
});
