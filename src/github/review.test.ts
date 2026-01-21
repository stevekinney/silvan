import { describe, expect, it } from 'bun:test';
import type { Octokit } from 'octokit';

import {
  fetchReviewApprovals,
  fetchReviewThreadById,
  fetchUnresolvedReviewComments,
  resolveReviewThread,
} from './review';

describe('review helpers', () => {
  it('fetches a review thread by id', async () => {
    const octokit = {
      graphql: async () => ({
        node: {
          __typename: 'PullRequestReviewThread',
          id: 'thread-1',
          isResolved: false,
          isOutdated: false,
          comments: { nodes: [] },
        },
      }),
    } as unknown as Octokit;

    const thread = await fetchReviewThreadById({
      threadId: 'thread-1',
      octokit,
      context: { runId: 'run-1', repoRoot: '/tmp' },
    });
    expect(thread.id).toBe('thread-1');
  });

  it('fetches unresolved review comments', async () => {
    const octokit = {
      rest: {
        pulls: {
          list: async () => ({
            data: [
              {
                number: 10,
                html_url: 'https://example.com/pr/10',
              },
            ],
          }),
        },
      },
      graphql: async () => ({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'thread-1',
                  isResolved: true,
                  isOutdated: false,
                  comments: {
                    nodes: [
                      { id: 'c1', body: 'done', path: null, line: null, url: null },
                    ],
                  },
                },
                {
                  id: 'thread-2',
                  isResolved: false,
                  isOutdated: true,
                  comments: {
                    nodes: [
                      {
                        id: 'c2',
                        body: 'fix',
                        path: 'src/index.ts',
                        line: 10,
                        url: 'https://example.com/c2',
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
    } as unknown as Octokit;

    const result = await fetchUnresolvedReviewComments({
      owner: 'acme',
      repo: 'repo',
      headBranch: 'feature/test',
      octokit,
      context: { runId: 'run-2', repoRoot: '/tmp' },
    });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.threadId).toBe('thread-2');
    expect(result.pr.number).toBe(10);
  });

  it('resolves review threads', async () => {
    const octokit = {
      graphql: async () => ({
        resolveReviewThread: { thread: { id: 'thread-3', isResolved: true } },
      }),
    } as unknown as Octokit;
    const result = await resolveReviewThread({
      threadId: 'thread-3',
      octokit,
      context: { runId: 'run-3', repoRoot: '/tmp' },
    });
    expect(result.resolved).toBe(true);
  });

  it('counts the latest approvals per reviewer', async () => {
    const octokit = {
      rest: {
        pulls: {
          listReviews: async () => ({
            data: [
              { user: { login: 'alice' }, state: 'COMMENTED' },
              { user: { login: 'alice' }, state: 'APPROVED' },
              { user: { login: 'bob' }, state: 'APPROVED' },
            ],
          }),
        },
      },
    } as unknown as Octokit;
    const result = await fetchReviewApprovals({
      pr: { owner: 'acme', repo: 'repo', number: 11 },
      token: 'token',
      octokit,
      context: { runId: 'run-4', repoRoot: '/tmp' },
    });
    expect(result.approvedCount).toBe(2);
  });
});
