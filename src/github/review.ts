import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import type { PrIdent } from '../events/schema';
import { createOctokit } from './client';
import { emitGitHubError } from './errors';

export type ReviewComment = {
  id: string;
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

const RESOLVE_THREAD_MUTATION = `
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

const REVIEW_THREADS_QUERY = `
  query UnresolvedReviewThreads(
    $owner: String!
    $repo: String!
    $number: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            isOutdated
            comments(first: 100) {
              nodes {
                id
                body
                path
                line
                url
              }
            }
          }
        }
      }
    }
  }
`;

const REVIEW_THREAD_QUERY = `
  query ReviewThread($id: ID!) {
    node(id: $id) {
      __typename
      ... on PullRequestReviewThread {
        id
        isResolved
        isOutdated
        comments(first: 100) {
          nodes {
            id
            body
            path
            line
            url
          }
        }
      }
    }
  }
`;

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
  bus?: EventBus;
  context: EmitContext;
}): Promise<PrIdent> {
  const octokit = createOctokit();
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
  bus?: EventBus;
  context: EmitContext;
}): Promise<ReviewThreadList> {
  const octokit = createOctokit();
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
  bus?: EventBus;
  context: EmitContext;
}): Promise<ReviewThreadNode> {
  const octokit = createOctokit();
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
  bus?: EventBus;
  context: EmitContext;
}): Promise<ReviewCommentsResult> {
  const pr = await findPrForBranch(options);
  const threads = await fetchReviewThreads({
    owner: options.owner,
    repo: options.repo,
    prNumber: pr.number,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });

  const mapped = threads
    .filter((thread) => !thread.isResolved)
    .flatMap((thread) =>
      thread.comments.nodes.map((comment) => ({
        id: comment.id,
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
  bus?: EventBus;
  context: EmitContext;
}): Promise<{ resolved: boolean }> {
  const octokit = createOctokit();
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
