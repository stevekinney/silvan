import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { Event } from '../events/schema';
import { initStateStore } from '../state/store';
import { buildAnalyticsReport } from './analytics';

async function withTempRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-analytics-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildEvent(options: {
  runId: string;
  repoId: string;
  ts: string;
  type: Event['type'];
  payload: Event['payload'];
  taskId?: string;
  error?: Event['error'];
}): Event {
  return {
    schema: 'com.silvan.events',
    version: '1.0.0',
    id: crypto.randomUUID(),
    ts: options.ts,
    level: 'info',
    source: 'cli',
    runId: options.runId,
    repoId: options.repoId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    type: options.type,
    payload: options.payload,
    ...(options.error ? { error: options.error } : {}),
  } as Event;
}

async function writeAuditLog(
  auditDir: string,
  runId: string,
  events: Event[],
): Promise<void> {
  const content = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  await writeFile(join(auditDir, `${runId}.jsonl`), content, 'utf8');
}

describe('analytics', () => {
  test('summarizes runs, phases, and failures', async () => {
    await withTempRepo(async (repoRoot) => {
      const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
      const base = Date.parse('2025-01-01T00:00:00.000Z');
      const run1 = 'run-1';
      const run2 = 'run-2';

      const run1Events: Event[] = [
        buildEvent({
          runId: run1,
          repoId: state.repoId,
          ts: new Date(base).toISOString(),
          type: 'run.started',
          taskId: 'gh-12',
          payload: {
            runId: run1,
            command: 'silvan',
            args: [],
            cwd: repoRoot,
            repoRoot,
          },
        }),
        buildEvent({
          runId: run1,
          repoId: state.repoId,
          ts: new Date(base).toISOString(),
          type: 'run.phase_changed',
          payload: { from: 'idle', to: 'plan' },
        }),
        buildEvent({
          runId: run1,
          repoId: state.repoId,
          ts: new Date(base + 5 * 60 * 1000).toISOString(),
          type: 'run.phase_changed',
          payload: { from: 'plan', to: 'implement' },
        }),
        buildEvent({
          runId: run1,
          repoId: state.repoId,
          ts: new Date(base + 10 * 60 * 1000).toISOString(),
          type: 'run.finished',
          payload: { status: 'success', durationMs: 10 * 60 * 1000 },
        }),
      ];

      const run2Events: Event[] = [
        buildEvent({
          runId: run2,
          repoId: state.repoId,
          ts: new Date(base + 60 * 60 * 1000).toISOString(),
          type: 'run.started',
          taskId: 'ENG-33',
          payload: {
            runId: run2,
            command: 'silvan',
            args: [],
            cwd: repoRoot,
            repoRoot,
          },
        }),
        buildEvent({
          runId: run2,
          repoId: state.repoId,
          ts: new Date(base + 60 * 60 * 1000).toISOString(),
          type: 'run.phase_changed',
          payload: { from: 'idle', to: 'plan' },
        }),
        buildEvent({
          runId: run2,
          repoId: state.repoId,
          ts: new Date(base + 62 * 60 * 1000).toISOString(),
          type: 'run.phase_changed',
          payload: { from: 'plan', to: 'verify' },
        }),
        buildEvent({
          runId: run2,
          repoId: state.repoId,
          ts: new Date(base + 65 * 60 * 1000).toISOString(),
          type: 'run.finished',
          payload: { status: 'failed', durationMs: 5 * 60 * 1000 },
          error: { name: 'Error', message: 'Verify failed', code: 'verify.failed' },
        }),
      ];

      await writeAuditLog(state.auditDir, run1, run1Events);
      await writeAuditLog(state.auditDir, run2, run2Events);

      const report = await buildAnalyticsReport({ state });
      expect(report.summary.runsStarted).toBe(2);
      expect(report.summary.runsSuccess).toBe(1);
      expect(report.summary.runsFailed).toBe(1);
      expect(report.summary.avgTimeToConvergenceMs).toBe(10 * 60 * 1000);

      const planPhase = report.phases.find((phase) => phase.phase === 'plan');
      expect(planPhase?.sampleCount).toBe(2);
      expect(planPhase?.avgDurationMs).toBeCloseTo(3.5 * 60 * 1000, 0);

      const failure = report.failures.find((entry) => entry.reason === 'verify.failed');
      expect(failure?.count).toBe(1);
      expect(failure?.sampleRuns).toContain(run2);
    });
  });

  test('filters by provider and time range', async () => {
    await withTempRepo(async (repoRoot) => {
      const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
      const base = Date.parse('2025-01-01T00:00:00.000Z');
      const run1 = 'run-a';
      const run2 = 'run-b';

      await writeAuditLog(state.auditDir, run1, [
        buildEvent({
          runId: run1,
          repoId: state.repoId,
          ts: new Date(base).toISOString(),
          type: 'run.started',
          taskId: 'gh-88',
          payload: {
            runId: run1,
            command: 'silvan',
            args: [],
            cwd: repoRoot,
            repoRoot,
          },
        }),
      ]);

      await writeAuditLog(state.auditDir, run2, [
        buildEvent({
          runId: run2,
          repoId: state.repoId,
          ts: new Date(base + 2 * 60 * 60 * 1000).toISOString(),
          type: 'run.started',
          taskId: 'ENG-77',
          payload: {
            runId: run2,
            command: 'silvan',
            args: [],
            cwd: repoRoot,
            repoRoot,
          },
        }),
      ]);

      const providerReport = await buildAnalyticsReport({
        state,
        filters: { providers: ['github'] },
      });
      expect(providerReport.summary.runsStarted).toBe(1);

      const sinceReport = await buildAnalyticsReport({
        state,
        filters: { since: new Date(base + 60 * 60 * 1000).toISOString() },
      });
      expect(sinceReport.summary.runsStarted).toBe(1);
    });
  });
});
