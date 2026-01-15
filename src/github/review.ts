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

export async function fetchUnresolvedReviewComments(options: {
  owner: string;
  repo: string;
  headBranch: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<ReviewComment[]> {
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

  return mapped;
}
