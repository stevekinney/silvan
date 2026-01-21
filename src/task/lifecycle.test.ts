import type { LinearClient } from '@linear/sdk';
import { describe, expect, it } from 'bun:test';
import type { Octokit } from 'octokit';

import { configSchema } from '../config/schema';
import {
  commentOnPrOpen,
  completeTask,
  moveTaskToInProgress,
  moveTaskToInReview,
} from './lifecycle';
import type { Task } from './types';

function buildConfig() {
  const base = configSchema.parse({});
  return {
    ...base,
    github: {
      ...base.github,
      owner: 'acme',
      repo: 'repo',
      token: 'token',
    },
    linear: {
      ...base.linear,
      token: 'linear-token',
    },
    task: {
      ...base.task,
      providers: {
        ...base.task.providers,
        enabled: ['github', 'linear', 'local'] as Array<'github' | 'linear' | 'local'>,
      },
      github: {
        ...base.task.github,
        closeOnSuccess: true,
        commentOnPrOpen: true,
        labelMapping: {
          inProgress: 'status:in-progress',
          inReview: 'status:review',
          done: 'status:done',
        },
      },
      linear: {
        ...base.task.linear,
        states: {
          inProgress: 'In Progress',
          inReview: 'In Review',
          done: 'Done',
        },
      },
    },
  };
}

const githubTask: Task = {
  id: 'gh-1',
  key: 'gh-1',
  provider: 'github',
  title: 'Task',
  description: '',
  acceptanceCriteria: [],
  labels: [],
  metadata: { owner: 'acme', repo: 'repo', number: 1 },
};

const linearTask: Task = {
  id: 'ENG-1',
  key: 'ENG-1',
  provider: 'linear',
  title: 'Task',
  description: '',
  acceptanceCriteria: [],
  labels: [],
  metadata: { teamKey: 'ENG' },
};

describe('task lifecycle', () => {
  it('applies GitHub labels for in-progress and in-review', async () => {
    const calls: Array<{ labels: string[] }> = [];
    const octokit = {
      rest: {
        issues: {
          addLabels: async (payload: { labels: string[] }) => {
            calls.push(payload);
          },
        },
      },
    } as unknown as Octokit;
    const config = buildConfig();

    await moveTaskToInProgress(githubTask, config, { octokit });
    await moveTaskToInReview(githubTask, config, { octokit });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.labels).toEqual(['status:in-progress']);
    expect(calls[1]?.labels).toEqual(['status:review']);
  });

  it('closes GitHub issues on completion when configured', async () => {
    const labelCalls: Array<{ labels: string[] }> = [];
    const closeCalls: Array<{ state: string }> = [];
    const octokit = {
      rest: {
        issues: {
          addLabels: async (payload: { labels: string[] }) => {
            labelCalls.push(payload);
          },
          update: async (payload: { state: string }) => {
            closeCalls.push(payload);
          },
        },
      },
    } as unknown as Octokit;
    const config = buildConfig();

    await completeTask(githubTask, config, { octokit });

    expect(labelCalls).toHaveLength(1);
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]?.state).toBe('closed');
  });

  it('posts a PR comment when enabled', async () => {
    const calls: Array<{ body: string }> = [];
    const octokit = {
      rest: {
        issues: {
          createComment: async (payload: { body: string }) => {
            calls.push(payload);
          },
        },
      },
    } as unknown as Octokit;
    const config = buildConfig();

    await commentOnPrOpen(githubTask, config, 'https://example.com/pr/1', octokit);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain('PR opened');
  });

  it('moves Linear tickets when enabled', async () => {
    const updates: Array<{ stateId: string }> = [];
    const linear = {
      issue: async () => ({
        team: Promise.resolve({
          states: async () => ({ nodes: [{ id: 's1', name: 'In Progress' }] }),
        }),
        update: async (payload: { stateId: string }) => {
          updates.push(payload);
        },
      }),
    } as unknown as LinearClient;
    const config = buildConfig();

    await moveTaskToInProgress(linearTask, config, { linear });
    expect(updates).toEqual([{ stateId: 's1' }]);
  });
});
