import { describe, expect, it } from 'bun:test';
import { render } from 'ink-testing-library';

import type { RunRecord } from '../types';
import { RunListCompact } from './run-list-compact';

describe('RunListCompact', () => {
  it('renders a single-line run entry', () => {
    const runs: RunRecord[] = [
      {
        runId: 'run-1234567890',
        status: 'running',
        phase: 'plan',
        updatedAt: new Date().toISOString(),
        taskTitle: 'Build a compact list',
      },
    ];
    const { lastFrame } = render(
      <RunListCompact
        runs={runs}
        selectedRunId="run-1234567890"
        nowMs={Date.now()}
        width={80}
        maxRows={5}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('run-1234'.slice(0, 8));
    expect(frame).toContain('RUN');
  });

  it('caps output when maxRows is exceeded', () => {
    const runs: RunRecord[] = [
      {
        runId: 'run-1',
        status: 'success',
        phase: 'verify',
        updatedAt: new Date().toISOString(),
      },
      {
        runId: 'run-2',
        status: 'success',
        phase: 'verify',
        updatedAt: new Date().toISOString(),
      },
      {
        runId: 'run-3',
        status: 'success',
        phase: 'verify',
        updatedAt: new Date().toISOString(),
      },
    ];
    const { lastFrame } = render(
      <RunListCompact
        runs={runs}
        selectedRunId="run-1"
        nowMs={Date.now()}
        width={60}
        maxRows={2}
        groupByRepo={false}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('... 2 more');
  });
});
