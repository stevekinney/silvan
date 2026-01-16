import type { Config } from '../config/schema';
import { createOctokit } from '../github/client';
import { moveLinearTicket } from '../linear/linear';
import type { Task } from './types';

export async function moveTaskToInProgress(task: Task, config: Config): Promise<void> {
  if (task.provider === 'local') return;
  if (task.provider === 'linear') {
    const state = config.task.linear.states.inProgress;
    if (!config.task.providers.enabled.includes('linear') || !state) return;
    await moveLinearTicket(task.id, state, config.linear.token);
    return;
  }

  await applyGitHubLabel(task, config, 'inProgress');
}

export async function moveTaskToInReview(task: Task, config: Config): Promise<void> {
  if (task.provider === 'local') return;
  if (task.provider === 'linear') {
    const state = config.task.linear.states.inReview;
    if (!config.task.providers.enabled.includes('linear') || !state) return;
    await moveLinearTicket(task.id, state, config.linear.token);
    return;
  }

  await applyGitHubLabel(task, config, 'inReview');
}

export async function completeTask(task: Task, config: Config): Promise<void> {
  if (task.provider === 'local') return;
  if (task.provider === 'linear') {
    const state = config.task.linear.states.done;
    if (!config.task.providers.enabled.includes('linear') || !state) return;
    await moveLinearTicket(task.id, state, config.linear.token);
    return;
  }

  await applyGitHubLabel(task, config, 'done');

  if (config.task.github.closeOnSuccess) {
    await closeGitHubIssue(task, config);
  }
}

export async function commentOnPrOpen(
  task: Task,
  config: Config,
  prUrl: string,
): Promise<void> {
  if (task.provider === 'local') return;
  if (task.provider !== 'github' || !config.task.github.commentOnPrOpen) return;
  const meta = task.metadata as
    | { owner?: string; repo?: string; number?: number }
    | undefined;
  if (!meta?.owner || !meta?.repo || !meta?.number) return;

  const octokit = createOctokit(config.github.token);
  await octokit.rest.issues.createComment({
    owner: meta.owner,
    repo: meta.repo,
    issue_number: meta.number,
    body: `PR opened: ${prUrl}`,
  });
}

async function closeGitHubIssue(task: Task, config: Config): Promise<void> {
  const meta = task.metadata as
    | { owner?: string; repo?: string; number?: number }
    | undefined;
  if (!meta?.owner || !meta?.repo || !meta?.number) return;
  const octokit = createOctokit(config.github.token);
  await octokit.rest.issues.update({
    owner: meta.owner,
    repo: meta.repo,
    issue_number: meta.number,
    state: 'closed',
  });
}

async function applyGitHubLabel(
  task: Task,
  config: Config,
  phase: 'inProgress' | 'inReview' | 'done',
): Promise<void> {
  const mapping = config.task.github.labelMapping ?? {};
  const label = mapping[phase];
  if (!label) return;
  const meta = task.metadata as
    | { owner?: string; repo?: string; number?: number }
    | undefined;
  if (!meta?.owner || !meta?.repo || !meta?.number) return;
  const octokit = createOctokit(config.github.token);
  await octokit.rest.issues.addLabels({
    owner: meta.owner,
    repo: meta.repo,
    issue_number: meta.number,
    labels: [label],
  });
}
