import type { LinearClient } from '@linear/sdk';
import type { Octokit } from 'octokit';

import type { Config } from '../config/schema';
import { createOctokit } from '../github/client';
import { moveLinearTicket } from '../linear/linear';
import { isTaskProviderEnabled } from './provider';
import type { Task } from './types';

type LifecycleClients = {
  octokit?: Octokit;
  linear?: LinearClient;
};

export async function moveTaskToInProgress(
  task: Task,
  config: Config,
  clients?: LifecycleClients,
): Promise<void> {
  if (task.provider === 'local') return;
  if (task.provider === 'linear') {
    const state = config.task.linear.states.inProgress;
    if (!isTaskProviderEnabled(config, 'linear') || !state) return;
    await moveLinearTicket(task.id, state, config.linear.token, clients?.linear);
    return;
  }

  await applyGitHubLabel(task, config, 'inProgress', clients?.octokit);
}

export async function moveTaskToInReview(
  task: Task,
  config: Config,
  clients?: LifecycleClients,
): Promise<void> {
  if (task.provider === 'local') return;
  if (task.provider === 'linear') {
    const state = config.task.linear.states.inReview;
    if (!isTaskProviderEnabled(config, 'linear') || !state) return;
    await moveLinearTicket(task.id, state, config.linear.token, clients?.linear);
    return;
  }

  await applyGitHubLabel(task, config, 'inReview', clients?.octokit);
}

export async function completeTask(
  task: Task,
  config: Config,
  clients?: LifecycleClients,
): Promise<void> {
  if (task.provider === 'local') return;
  if (task.provider === 'linear') {
    const state = config.task.linear.states.done;
    if (!isTaskProviderEnabled(config, 'linear') || !state) return;
    await moveLinearTicket(task.id, state, config.linear.token, clients?.linear);
    return;
  }

  await applyGitHubLabel(task, config, 'done', clients?.octokit);

  if (config.task.github.closeOnSuccess) {
    await closeGitHubIssue(task, config, clients?.octokit);
  }
}

export async function commentOnPrOpen(
  task: Task,
  config: Config,
  prUrl: string,
  octokit?: Octokit,
): Promise<void> {
  if (task.provider === 'local') return;
  if (task.provider !== 'github' || !config.task.github.commentOnPrOpen) return;
  const meta = task.metadata as
    | { owner?: string; repo?: string; number?: number }
    | undefined;
  if (!meta?.owner || !meta?.repo || !meta?.number) return;

  const client = octokit ?? createOctokit(config.github.token);
  await client.rest.issues.createComment({
    owner: meta.owner,
    repo: meta.repo,
    issue_number: meta.number,
    body: `PR opened: ${prUrl}`,
  });
}

async function closeGitHubIssue(
  task: Task,
  config: Config,
  octokit?: Octokit,
): Promise<void> {
  const meta = task.metadata as
    | { owner?: string; repo?: string; number?: number }
    | undefined;
  if (!meta?.owner || !meta?.repo || !meta?.number) return;
  const client = octokit ?? createOctokit(config.github.token);
  await client.rest.issues.update({
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
  octokit?: Octokit,
): Promise<void> {
  const mapping = config.task.github.labelMapping ?? {};
  const label = mapping[phase];
  if (!label) return;
  const meta = task.metadata as
    | { owner?: string; repo?: string; number?: number }
    | undefined;
  if (!meta?.owner || !meta?.repo || !meta?.number) return;
  const client = octokit ?? createOctokit(config.github.token);
  await client.rest.issues.addLabels({
    owner: meta.owner,
    repo: meta.repo,
    issue_number: meta.number,
    labels: [label],
  });
}
