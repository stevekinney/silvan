import { describe, expect, it } from 'bun:test';
import type { Octokit } from 'octokit';

import {
  findMergedPr,
  listOpenPullRequests,
  openOrUpdatePr,
  requestReviewers,
} from './pr';

function createOctokitStub(options: {
  listOpen?: Array<{
    number: number;
    html_url?: string;
    title?: string;
    head?: { ref: string; sha: string };
    base?: { ref: string };
    draft?: boolean;
  }>;
  listClosed?: Array<{
    number: number;
    html_url?: string;
    title?: string;
    head?: { ref: string };
    base?: { ref: string };
    merged_at?: string | null;
  }>;
}) {
  const listOpen = options.listOpen ?? [];
  const listClosed = options.listClosed ?? [];
  const calls = {
    update: [] as unknown[],
    create: [] as unknown[],
    requestReviewers: [] as unknown[],
    request: [] as unknown[],
  };
  const octokit = {
    rest: {
      pulls: {
        list: async ({ state }: { state: string }) => ({
          data: state === 'closed' ? listClosed : listOpen,
        }),
        update: async (payload: unknown) => {
          calls.update.push(payload);
          return { data: {} };
        },
        create: async (payload: unknown) => {
          calls.create.push(payload);
          return { data: { number: 99, html_url: 'https://example.com/pr/99' } };
        },
        requestReviewers: async (payload: unknown) => {
          calls.requestReviewers.push(payload);
          return { data: {} };
        },
      },
    },
    request: async (_route: string, payload: unknown) => {
      calls.request.push(payload);
      return { data: {} };
    },
  } as unknown as Octokit;
  return { octokit, calls };
}

describe('openOrUpdatePr', () => {
  it('updates an existing PR', async () => {
    const { octokit, calls } = createOctokitStub({
      listOpen: [
        {
          number: 3,
          html_url: 'https://example.com/pr/3',
          head: { ref: 'feat', sha: 'sha-3' },
        },
      ],
    });
    const result = await openOrUpdatePr({
      owner: 'acme',
      repo: 'repo',
      headBranch: 'feat',
      baseBranch: 'main',
      title: 'Update',
      body: 'Body',
      octokit,
      context: { runId: 'run-1', repoRoot: '/tmp' },
    });
    expect(result.action).toBe('updated');
    expect(calls.update).toHaveLength(1);
  });

  it('creates a PR when none exists', async () => {
    const { octokit, calls } = createOctokitStub({ listOpen: [] });
    const result = await openOrUpdatePr({
      owner: 'acme',
      repo: 'repo',
      headBranch: 'feat',
      baseBranch: 'main',
      title: 'Create',
      body: 'Body',
      octokit,
      context: { runId: 'run-2', repoRoot: '/tmp' },
    });
    expect(result.action).toBe('opened');
    expect(calls.create).toHaveLength(1);
  });
});

describe('requestReviewers', () => {
  it('requests reviewers and optional Copilot', async () => {
    const { octokit, calls } = createOctokitStub({ listOpen: [] });
    await requestReviewers({
      pr: { owner: 'acme', repo: 'repo', number: 4 },
      reviewers: ['steve'],
      requestCopilot: true,
      octokit,
      context: { runId: 'run-3', repoRoot: '/tmp' },
    });
    expect(calls.requestReviewers).toHaveLength(1);
    expect(calls.request).toHaveLength(1);
  });
});

describe('findMergedPr', () => {
  it('returns merged PR info when found', async () => {
    const { octokit } = createOctokitStub({
      listClosed: [
        {
          number: 10,
          title: 'Done',
          html_url: 'https://example.com/pr/10',
          head: { ref: 'feat' },
          base: { ref: 'main' },
          merged_at: '2024-01-01T00:00:00Z',
        },
      ],
    });
    const result = await findMergedPr({
      owner: 'acme',
      repo: 'repo',
      headBranch: 'feat',
      octokit,
      context: { runId: 'run-4', repoRoot: '/tmp' },
    });
    expect(result?.number).toBe(10);
  });

  it('returns null when no merged PR exists', async () => {
    const { octokit } = createOctokitStub({
      listClosed: [{ number: 1, title: 'Closed', merged_at: null }],
    });
    const result = await findMergedPr({
      owner: 'acme',
      repo: 'repo',
      headBranch: 'feat',
      octokit,
      context: { runId: 'run-5', repoRoot: '/tmp' },
    });
    expect(result).toBeNull();
  });
});

describe('listOpenPullRequests', () => {
  it('lists open pull requests', async () => {
    const { octokit } = createOctokitStub({
      listOpen: [
        {
          number: 11,
          html_url: 'https://example.com/pr/11',
          title: 'Hello',
          head: { ref: 'feat', sha: 'sha-11' },
          base: { ref: 'main' },
          draft: true,
        },
      ],
    });
    const result = await listOpenPullRequests({
      owner: 'acme',
      repo: 'repo',
      octokit,
      context: { runId: 'run-6', repoRoot: '/tmp' },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.isDraft).toBe(true);
  });
});
