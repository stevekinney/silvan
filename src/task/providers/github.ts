import type { Octokit } from 'octokit';

import { createOctokit } from '../../github/client';
import type { Task } from '../types';
import {
  extractAcceptanceCriteria,
  extractChecklistItems,
  normalizeCriteria,
} from '../utils';

export type GitHubIssueRef = {
  owner: string;
  repo: string;
  number: number;
};

export async function fetchGitHubTask(
  ref: GitHubIssueRef,
  token?: string,
  octokit?: Octokit,
): Promise<Task> {
  const client = octokit ?? createOctokit(token);
  const issue = await client.rest.issues.get({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.number,
  });

  const body = issue.data.body ?? '';
  const labels = issue.data.labels
    .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
    .filter((label) => label.length > 0);
  const acceptanceCriteria = normalizeCriteria([
    ...extractAcceptanceCriteria(body),
    ...extractChecklistItems(body),
    ...labels.map((label) => `Label: ${label}`),
  ]);

  return {
    id: `gh-${issue.data.number}`,
    provider: 'github',
    title: issue.data.title ?? `Issue #${issue.data.number}`,
    description: body,
    acceptanceCriteria,
    url: issue.data.html_url ?? undefined,
    labels,
    ...(issue.data.assignee?.login ? { assignee: issue.data.assignee.login } : {}),
    state: issue.data.state,
    metadata: {
      owner: ref.owner,
      repo: ref.repo,
      number: issue.data.number,
    },
  };
}

export function parseGitHubIssueUrl(url: string): GitHubIssueRef | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('github.com')) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 4) return null;
    const [owner, repo, type, number] = parts;
    if (!owner || !repo || !number) return null;
    if (type !== 'issues') return null;
    const issueNumber = Number(number);
    if (!Number.isFinite(issueNumber)) return null;
    return { owner, repo, number: issueNumber };
  } catch {
    return null;
  }
}
