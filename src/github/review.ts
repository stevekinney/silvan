import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { createOctokit } from './client';

export type ReviewComment = {
  id: string;
  path: string;
  line: number | null;
  body: string;
  url?: string;
};

export async function fetchUnresolvedReviewComments(options: {
  owner: string;
  repo: string;
  headBranch: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<ReviewComment[]> {
  const octokit = createOctokit();
  const prs = await octokit.rest.pulls.list({
    owner: options.owner,
    repo: options.repo,
    head: `${options.owner}:${options.headBranch}`,
    state: 'open',
  });

  if (prs.data.length === 0) {
    throw new Error('No open PR found for branch');
  }

  const pr = prs.data[0]!;
  const threads = await octokit.rest.pulls.listReviewComments({
    owner: options.owner,
    repo: options.repo,
    pull_number: pr.number,
    per_page: 100,
  });

  const mapped = threads.data.map((comment) => ({
    id: String(comment.id),
    path: comment.path,
    line: comment.line ?? null,
    body: comment.body,
    url: comment.html_url ?? undefined,
  }));

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
          pr: {
            owner: options.owner,
            repo: options.repo,
            number: pr.number,
            url: pr.html_url ?? undefined,
          },
          unresolvedCount: mapped.length,
          totalCount: threads.data.length,
        },
      }),
    );
  }

  return mapped;
}
