import { describe, expect, it } from 'bun:test';
import { render } from 'ink-testing-library';

import type { Event } from '../../events/schema';
import type { QueueRecord, RunRecord, WorktreeRecord } from '../types';
import { ActivityFeed } from './activity-feed';
import { AttentionQueue } from './attention-queue';
import { FilterBar } from './filter-bar';
import { FilterPrompt } from './filter-prompt';
import { HelpOverlay } from './help-overlay';
import { OpenPrsPanel } from './open-prs-panel';
import { PrCiReviewPanel } from './pr-ci-review-panel';
import { QueuePanel } from './queue-panel';
import { RequestForm } from './request-form';
import { StepTimeline } from './step-timeline';
import { WorktreePanel } from './worktree-panel';

describe('ui components', () => {
  it('renders filter components', () => {
    const { lastFrame } = render(
      <FilterPrompt
        label="Filter"
        value="test"
        hint="hint"
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(lastFrame()).toContain('Filter');

    const { lastFrame: barFrame } = render(
      <FilterBar query="query" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(barFrame()).toContain('/');
  });

  it('renders help overlay', () => {
    const { lastFrame } = render(<HelpOverlay />);
    expect(lastFrame()).toContain('Keybindings');
  });

  it('renders attention queue and activity feed', () => {
    const runs: RunRecord[] = [
      {
        runId: 'run-1',
        status: 'failed',
        phase: 'verify',
        updatedAt: new Date().toISOString(),
      },
    ];
    const { lastFrame } = render(<AttentionQueue runs={runs} nowMs={Date.now()} />);
    expect(lastFrame()).toContain('Needs Attention');

    const events: Event[] = [
      {
        id: 'evt-1',
        type: 'run.step',
        ts: new Date().toISOString(),
        level: 'info',
        source: 'engine',
        payload: { stepId: 'plan', title: 'Plan', status: 'succeeded' },
      } as Event,
    ];
    const { lastFrame: feedFrame } = render(
      <ActivityFeed
        stateStore={{} as Parameters<typeof ActivityFeed>[0]['stateStore']}
        runId="run-1"
        events={events}
        loading={false}
      />,
    );
    expect(feedFrame()).toContain('run.step');
  });

  it('renders open PRs and queue panels', () => {
    const { lastFrame } = render(
      <OpenPrsPanel
        prs={[
          {
            id: 'acme/repo#1',
            title: 'PR',
            headBranch: 'feat',
            baseBranch: 'main',
            ci: 'passing',
            unresolvedReviewCount: 0,
          },
        ]}
      />,
    );
    expect(lastFrame()).toContain('PR');

    const requests: QueueRecord[] = [
      { id: 'req-1', title: 'Task', createdAt: new Date().toISOString() },
    ];
    const { lastFrame: queueFrame } = render(
      <QueuePanel requests={requests} nowMs={Date.now()} hint="hint" />,
    );
    expect(queueFrame()).toContain('Task');
  });

  it('renders request form and step timeline', () => {
    const { lastFrame } = render(
      <RequestForm
        step="title"
        title="Title"
        description=""
        onTitleChange={() => {}}
        onDescriptionChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(lastFrame()).toContain('New task request');

    const { lastFrame: timelineFrame } = render(
      <StepTimeline
        steps={[
          {
            stepId: 'plan',
            title: 'Plan',
            status: 'completed',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          },
        ]}
      />,
    );
    expect(timelineFrame()).toContain('Plan');
  });

  it('renders worktree panel', () => {
    const worktrees: Array<
      WorktreeRecord & { repoLabel: string; isStale: boolean; isOrphaned: boolean }
    > = [
      {
        id: 'wt-1',
        path: '/tmp/worktree',
        branch: 'feat',
        repoLabel: 'repo',
        lastActivityAt: new Date().toISOString(),
        isStale: false,
        isOrphaned: false,
      },
    ];
    const { lastFrame } = render(
      <WorktreePanel worktrees={worktrees} nowMs={Date.now()} />,
    );
    expect(lastFrame()).toContain('repo');
  });

  it('renders PR/CI/review summary', () => {
    const run: RunRecord = {
      runId: 'run-2',
      status: 'running',
      phase: 'pr',
      updatedAt: new Date().toISOString(),
      pr: { id: 'acme/repo#2', title: 'PR 2', headBranch: 'feat', baseBranch: 'main' },
      ci: {
        state: 'passing',
        checks: [{ name: 'test', state: 'completed', conclusion: 'success' }],
      },
      review: { unresolvedCount: 1, totalCount: 2, iteration: 1 },
    };
    const events: Event[] = [
      {
        id: 'evt-2',
        type: 'github.pr_opened_or_updated',
        ts: new Date().toISOString(),
        level: 'info',
        source: 'github',
        payload: {
          pr: { owner: 'acme', repo: 'repo', number: 2 },
          action: 'opened',
          headBranch: 'feat',
          baseBranch: 'main',
          title: 'PR 2',
        },
      } as Event,
    ];
    const { lastFrame } = render(
      <PrCiReviewPanel run={run} events={events} nowMs={Date.now()} />,
    );
    expect(lastFrame()).toContain('PR / CI / Reviews');
  });
});
