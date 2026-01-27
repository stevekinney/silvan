import type { Octokit } from 'octokit';

import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import type { PrIdent } from '../events/schema';
import { createOctokit } from './client';
import { emitGitHubError } from './errors';
import resolveThreadMutation from './queries/resolve-thread.graphql';
import reviewThreadQuery from './queries/review-thread.graphql';
import reviewThreadsQuery from './queries/review-threads.graphql';

export type ReviewComment = {
  id: string;
  databaseId?: number | null;
  threadId: string;
  path: string | null;
  line: number | null;
  body: string;
  url?: string;
  isOutdated: boolean;
};

export type ReviewCommentsResult = {
  pr: PrIdent;
  comments: ReviewComment[];
};

const RESOLVE_THREAD_MUTATION = resolveThreadMutation;
const REVIEW_THREADS_QUERY = reviewThreadsQuery;
const REVIEW_THREAD_QUERY = reviewThreadQuery;

type ReviewThreadsResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          comments: {
            nodes: Array<{
              id: string;
              databaseId: number | null;
              body: string;
              path: string | null;
              line: number | null;
              url: string | null;
            }>;
          };
        }>;
      } | null;
    } | null;
  } | null;
};

type ReviewThreadNode = NonNullable<
  NonNullable<
    NonNullable<ReviewThreadsResponse['repository']>['pullRequest']
  >['reviewThreads']
>['nodes'][number];

type ReviewThreadList = ReviewThreadNode[];

type ResolveThreadResponse = {
  resolveReviewThread: {
    thread: { id: string; isResolved: boolean } | null;
  } | null;
};

type ReviewThreadResponse = {
  node:
    | {
        __typename: 'PullRequestReviewThread';
        id: string;
        isResolved: boolean;
        isOutdated: boolean;
        comments: {
          nodes: Array<{
            id: string;
            databaseId: number | null;
            body: string;
            path: string | null;
            line: number | null;
            url: string | null;
          }>;
        };
      }
    | { __typename: string }
    | null;
};

async function findPrForBranch(options: {
  owner: string;
  repo: string;
  headBranch: string;
  token?: string;
  octokit?: Octokit;
  bus?: EventBus;
  context: EmitContext;
}): Promise<PrIdent> {
  const octokit = options.octokit ?? createOctokit(options.token);
  let prs;
  try {
    prs = await octokit.rest.pulls.list({
      owner: options.owner,
      repo: options.repo,
      head: `${options.owner}:${options.headBranch}`,
      state: 'open',
    });
  } catch (error) {
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'find_pr',
      error,
      details: `Failed to find PR for ${options.headBranch}`,
    });
    throw error;
  }

  if (prs.data.length === 0) {
    const error = new Error('No open PR found for branch');
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'find_pr',
      error,
      details: `No open PR found for ${options.headBranch}`,
    });
    throw error;
  }

  const pr = prs.data[0]!;
  return {
    owner: options.owner,
    repo: options.repo,
    number: pr.number,
    url: pr.html_url ?? undefined,
  };
}

async function fetchReviewThreads(options: {
  owner: string;
  repo: string;
  prNumber: number;
  token?: string;
  octokit?: Octokit;
  bus?: EventBus;
  context: EmitContext;
}): Promise<ReviewThreadList> {
  const octokit = options.octokit ?? createOctokit(options.token);
  const nodes: ReviewThreadList = [];
  let after: string | null = null;

  while (true) {
    let response: ReviewThreadsResponse;
    try {
      response = await octokit.graphql(REVIEW_THREADS_QUERY, {
        owner: options.owner,
        repo: options.repo,
        number: options.prNumber,
        after,
      });
    } catch (error) {
      await emitGitHubError({
        ...(options.bus ? { bus: options.bus } : {}),
        context: options.context,
        operation: 'fetch_comments',
        error,
        details: 'Failed to fetch review threads',
        pr: {
          owner: options.owner,
          repo: options.repo,
          number: options.prNumber,
        },
      });
      throw error;
    }

    const threads = response.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    const pageInfo = response.repository?.pullRequest?.reviewThreads?.pageInfo;
    nodes.push(...threads);

    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor ?? null;
    if (!after) break;
  }

  return nodes;
}

export async function fetchReviewThreadById(options: {
  threadId: string;
  token?: string;
  octokit?: Octokit;
  bus?: EventBus;
  context: EmitContext;
}): Promise<ReviewThreadNode> {
  const octokit = options.octokit ?? createOctokit(options.token);
  let response;
  try {
    response = await octokit.graphql<ReviewThreadResponse>(REVIEW_THREAD_QUERY, {
      id: options.threadId,
    });
  } catch (error) {
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'fetch_comments',
      error,
      details: 'Failed to fetch review thread',
    });
    throw error;
  }

  if (!response.node || response.node.__typename !== 'PullRequestReviewThread') {
    throw new Error('Review thread not found');
  }

  return response.node as ReviewThreadNode;
}

export async function fetchUnresolvedReviewComments(options: {
  owner: string;
  repo: string;
  headBranch: string;
  token?: string;
  octokit?: Octokit;
  bus?: EventBus;
  context: EmitContext;
}): Promise<ReviewCommentsResult> {
  const pr = await findPrForBranch({
    owner: options.owner,
    repo: options.repo,
    headBranch: options.headBranch,
    ...(options.token ? { token: options.token } : {}),
    ...(options.octokit ? { octokit: options.octokit } : {}),
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });
  const threads = await fetchReviewThreads({
    owner: options.owner,
    repo: options.repo,
    prNumber: pr.number,
    ...(options.token ? { token: options.token } : {}),
    ...(options.octokit ? { octokit: options.octokit } : {}),
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });

  const mapped = threads
    .filter((thread) => !thread.isResolved)
    .flatMap((thread) =>
      thread.comments.nodes.map((comment) => ({
        id: comment.id,
        databaseId: comment.databaseId ?? null,
        threadId: thread.id,
        path: comment.path ?? null,
        line: comment.line ?? null,
        body: comment.body,
        ...(comment.url ? { url: comment.url } : {}),
        isOutdated: thread.isOutdated,
      })),
    );

  const totalCount = threads.reduce(
    (sum, thread) => sum + thread.comments.nodes.length,
    0,
  );

  if (options.bus) {
    await options.bus.emit(
      createEnvelope({
        type: 'github.review_comments_fetched',
        source: 'github',
        level: 'info',
        context: {
          ...options.context,
          prId: `${options.owner}/${options.repo}#${pr.number}`,
        },
        payload: {
          pr,
          unresolvedCount: mapped.length,
          totalCount,
        },
      }),
    );
  }

  return { pr, comments: mapped };
}

export async function resolveReviewThread(options: {
  threadId: string;
  pr?: PrIdent;
  token?: string;
  octokit?: Octokit;
  bus?: EventBus;
  context: EmitContext;
}): Promise<{ resolved: boolean }> {
  const octokit = options.octokit ?? createOctokit(options.token);
  try {
    const response = await octokit.graphql<ResolveThreadResponse>(
      RESOLVE_THREAD_MUTATION,
      {
        threadId: options.threadId,
      },
    );
    const resolved = response.resolveReviewThread?.thread?.isResolved ?? false;
    if (options.bus && options.pr) {
      await options.bus.emit(
        createEnvelope({
          type: 'github.review_thread_resolved',
          source: 'github',
          level: 'info',
          context: options.context,
          payload: {
            pr: options.pr,
            threadId: options.threadId,
            resolved,
          },
        }),
      );
    }
    return { resolved };
  } catch (error) {
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'resolve_comment',
      error,
      details: 'Failed to resolve review thread',
    });
    throw error;
  }
}

export async function replyToReviewComment(options: {
  pr: PrIdent;
  commentId: number;
  body: string;
  token?: string;
  octokit?: Octokit;
  bus?: EventBus;
  context: EmitContext;
}): Promise<void> {
  const octokit = options.octokit ?? createOctokit(options.token);
  try {
    await octokit.request(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
      {
        owner: options.pr.owner,
        repo: options.pr.repo,
        pull_number: options.pr.number,
        comment_id: options.commentId,
        body: options.body,
      },
    );
  } catch (error) {
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'resolve_comment',
      error,
      pr: options.pr,
      details: 'Failed to reply to review comment',
    });
    throw error;
  }
}

export async function fetchReviewApprovals(options: {
  pr: { owner: string; repo: string; number: number };
  token: string;
  octokit?: Octokit;
  bus?: EventBus;
  context: EmitContext;
}): Promise<{ approvedCount: number }> {
  const octokit = options.octokit ?? createOctokit(options.token);
  let response;
  try {
    response = await octokit.rest.pulls.listReviews({
      owner: options.pr.owner,
      repo: options.pr.repo,
      pull_number: options.pr.number,
      per_page: 100,
    });
  } catch (error) {
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'fetch_comments',
      error,
      details: 'Failed to fetch PR reviews',
    });
    throw error;
  }

  const latestByReviewer = new Map<string, string>();
  for (const review of response.data) {
    const login = review.user?.login;
    if (!login) continue;
    latestByReviewer.set(login, review.state ?? 'COMMENTED');
  }

  const approvedCount = Array.from(latestByReviewer.values()).filter(
    (state) => state === 'APPROVED',
  ).length;

  return { approvedCount };
}

export async function fetchReviewResponses(options: {
  pr: { owner: string; repo: string; number: number };
  token: string;
  since?: string;
  octokit?: Octokit;
  bus?: EventBus;
  context: EmitContext;
}): Promise<
  Array<{
    reviewer: string;
    submittedAt: string;
    state: string;
  }>
> {
  const octokit = options.octokit ?? createOctokit(options.token);
  let response;
  try {
    response = await octokit.rest.pulls.listReviews({
      owner: options.pr.owner,
      repo: options.pr.repo,
      pull_number: options.pr.number,
      per_page: 100,
    });
  } catch (error) {
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'fetch_comments',
      error,
      details: 'Failed to fetch PR reviews',
    });
    throw error;
  }

  const sinceTs = options.since ? Date.parse(options.since) : undefined;
  return response.data
    .map((review) => ({
      reviewer: review.user?.login ?? '',
      submittedAt: review.submitted_at ?? '',
      state: review.state ?? 'COMMENTED',
    }))
    .filter((review) => review.reviewer && review.submittedAt)
    .filter((review) => {
      if (!sinceTs || Number.isNaN(sinceTs)) return true;
      const submittedTs = Date.parse(review.submittedAt);
      return !Number.isNaN(submittedTs) && submittedTs >= sinceTs;
    });
}
