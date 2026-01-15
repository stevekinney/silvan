import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import type { PrIdent } from '../events/schema';
import { createOctokit } from './client';
import { emitGitHubError } from './errors';

export type PrResult = {
  pr: PrIdent;
  action: 'opened' | 'updated' | 'noop';
  headBranch: string;
  baseBranch: string;
  title: string;
};

export async function openOrUpdatePr(options: {
  owner: string;
  repo: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<PrResult> {
  const octokit = createOctokit();
  const head = `${options.owner}:${options.headBranch}`;

  let existing;
  try {
    existing = await octokit.rest.pulls.list({
      owner: options.owner,
      repo: options.repo,
      head,
      state: 'open',
    });
  } catch (error) {
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'find_pr',
      error,
      details: `Failed to find PR for ${head}`,
    });
    throw error;
  }

  if (existing.data.length > 0) {
    const pr = existing.data[0]!;
    try {
      await octokit.rest.pulls.update({
        owner: options.owner,
        repo: options.repo,
        pull_number: pr.number,
        title: options.title,
        body: options.body,
        base: options.baseBranch,
      });
    } catch (error) {
      await emitGitHubError({
        ...(options.bus ? { bus: options.bus } : {}),
        context: options.context,
        operation: 'update_pr',
        error,
        pr: {
          owner: options.owner,
          repo: options.repo,
          number: pr.number,
          url: pr.html_url ?? undefined,
        },
        details: 'Failed to update PR',
      });
      throw error;
    }

    const prInfo: PrIdent = {
      owner: options.owner,
      repo: options.repo,
      number: pr.number,
      url: pr.html_url ?? undefined,
    };
    const action: PrResult['action'] = 'updated';

    if (options.bus) {
      await options.bus.emit(
        createEnvelope({
          type: 'github.pr_opened_or_updated',
          source: 'github',
          level: 'info',
          context: {
            ...options.context,
            prId: `${options.owner}/${options.repo}#${pr.number}`,
          },
          payload: {
            pr: prInfo,
            action,
            headBranch: options.headBranch,
            baseBranch: options.baseBranch,
            title: options.title,
          },
        }),
      );
    }

    return {
      pr: prInfo,
      action,
      headBranch: options.headBranch,
      baseBranch: options.baseBranch,
      title: options.title,
    };
  }

  let created;
  try {
    created = await octokit.rest.pulls.create({
      owner: options.owner,
      repo: options.repo,
      title: options.title,
      head: options.headBranch,
      base: options.baseBranch,
      body: options.body,
    });
  } catch (error) {
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'open_pr',
      error,
      details: `Failed to open PR for ${options.headBranch}`,
    });
    throw error;
  }

  const prInfo: PrIdent = {
    owner: options.owner,
    repo: options.repo,
    number: created.data.number,
    url: created.data.html_url ?? undefined,
  };

  const action: PrResult['action'] = 'opened';

  if (options.bus) {
    await options.bus.emit(
      createEnvelope({
        type: 'github.pr_opened_or_updated',
        source: 'github',
        level: 'info',
        context: {
          ...options.context,
          prId: `${options.owner}/${options.repo}#${created.data.number}`,
        },
        payload: {
          pr: prInfo,
          action,
          headBranch: options.headBranch,
          baseBranch: options.baseBranch,
          title: options.title,
        },
      }),
    );
  }

  return {
    pr: prInfo,
    action,
    headBranch: options.headBranch,
    baseBranch: options.baseBranch,
    title: options.title,
  };
}

export async function requestReviewers(options: {
  pr: PrIdent;
  reviewers: string[];
  requestCopilot: boolean;
  bus?: EventBus;
  context: EmitContext;
}): Promise<void> {
  const octokit = createOctokit();

  const reviewers = options.reviewers.filter((reviewer) => reviewer.length > 0);

  if (reviewers.length > 0) {
    try {
      await octokit.rest.pulls.requestReviewers({
        owner: options.pr.owner,
        repo: options.pr.repo,
        pull_number: options.pr.number,
        reviewers,
      });
    } catch (error) {
      await emitGitHubError({
        ...(options.bus ? { bus: options.bus } : {}),
        context: options.context,
        operation: 'request_review',
        error,
        pr: options.pr,
        details: 'Failed to request reviewers',
      });
      throw error;
    }
  }

  if (options.requestCopilot) {
    try {
      await octokit.request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers',
        {
          owner: options.pr.owner,
          repo: options.pr.repo,
          pull_number: options.pr.number,
          reviewers: ['github-copilot'],
        },
      );
    } catch (error) {
      await emitGitHubError({
        ...(options.bus ? { bus: options.bus } : {}),
        context: options.context,
        operation: 'request_review',
        error,
        pr: options.pr,
        details: 'Failed to request Copilot review',
      });
      // Ignore Copilot request errors to keep flow alive.
    }
  }

  if (options.bus) {
    await options.bus.emit(
      createEnvelope({
        type: 'github.review_requested',
        source: 'github',
        level: 'info',
        context: {
          ...options.context,
          prId: `${options.pr.owner}/${options.pr.repo}#${options.pr.number}`,
        },
        payload: {
          pr: options.pr,
          reviewers,
          copilotRequested: options.requestCopilot,
        },
      }),
    );
  }
}
