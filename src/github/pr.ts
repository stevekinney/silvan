import type { Config } from '../config/schema';
import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import type { PrIdent } from '../events/schema';
import { createOctokit } from './client';

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

  const existing = await octokit.rest.pulls.list({
    owner: options.owner,
    repo: options.repo,
    head,
    state: 'open',
  });

  if (existing.data.length > 0) {
    const pr = existing.data[0]!;
    await octokit.rest.pulls.update({
      owner: options.owner,
      repo: options.repo,
      pull_number: pr.number,
      title: options.title,
      body: options.body,
      base: options.baseBranch,
    });

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

  const created = await octokit.rest.pulls.create({
    owner: options.owner,
    repo: options.repo,
    title: options.title,
    head: options.headBranch,
    base: options.baseBranch,
    body: options.body,
  });

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
    await octokit.rest.pulls.requestReviewers({
      owner: options.pr.owner,
      repo: options.pr.repo,
      pull_number: options.pr.number,
      reviewers,
    });
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
    } catch {
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

export function loadGitHubConfig(config: Config): { owner: string; repo: string } {
  if (config.github.owner && config.github.repo) {
    return { owner: config.github.owner, repo: config.github.repo };
  }

  throw new Error('GitHub owner/repo must be configured');
}
