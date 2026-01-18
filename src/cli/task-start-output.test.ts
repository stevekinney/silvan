import { describe, expect, it } from 'bun:test';

import type { Plan } from '../agent/schemas';
import type { Task } from '../task/types';
import { renderPlanSummary, renderTaskHeader, summarizePlan } from './task-start-output';

describe('task start output helpers', () => {
  it('summarizes plan files, risks, and complexity', () => {
    const plan: Plan = {
      summary: 'Test plan summary',
      steps: [
        {
          id: 'step-1',
          title: 'Step one',
          description: 'Do step one',
          files: ['src/a.ts', 'src/b.ts'],
          risks: ['risk-a'],
          verification: ['check-a'],
          stopConditions: ['stop-a'],
        },
        {
          id: 'step-2',
          title: 'Step two',
          description: 'Do step two',
          files: ['src/b.ts', 'src/c.ts'],
          risks: ['risk-b'],
          verification: ['check-b'],
          stopConditions: ['stop-b'],
        },
      ],
      verification: ['run tests'],
    };

    const summary = summarizePlan(plan);
    expect(summary.steps).toBe(2);
    expect(summary.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(summary.risks).toEqual(['risk-a', 'risk-b']);
    expect(summary.complexity).toBe('Low');
  });

  it('renders task header and plan summary blocks', () => {
    const task: Task = {
      id: 'gh-42',
      key: 'gh-42',
      provider: 'github',
      title: 'Improve login',
      description: 'Fix login behavior',
      acceptanceCriteria: [],
      url: 'https://github.com/acme/repo/issues/42',
      labels: ['bug', 'priority:high'],
      state: 'open',
      metadata: { owner: 'acme', repo: 'repo', number: 42 },
    };

    const header = renderTaskHeader(task);
    expect(header).toContain('Task: Improve login');
    expect(header).toContain('Ref');
    expect(header).toContain('GitHub issue');

    const summary = summarizePlan({
      summary: 'Plan summary',
      steps: [
        {
          id: 'step-1',
          title: 'Step one',
          description: 'Do step one',
          verification: ['check'],
          stopConditions: ['stop'],
        },
      ],
      verification: ['run tests'],
    });

    const summaryBlock = renderPlanSummary(summary);
    expect(summaryBlock).toContain('Plan Summary');
    expect(summaryBlock).toContain('Steps');
    expect(summaryBlock).toContain('Files');
    expect(summaryBlock).toContain('Risks');
  });
});
