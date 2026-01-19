import type { RunRecord, RunStatus } from './types';

export type RunSummary = {
  total: number;
  status: Record<RunStatus | 'blocked', number>;
  phase: Record<string, number>;
  convergence: Record<string, number>;
};

export function buildRunSummary(runs: RunRecord[]): RunSummary {
  const summary: RunSummary = {
    total: runs.length,
    status: {
      running: 0,
      success: 0,
      failed: 0,
      canceled: 0,
      unknown: 0,
      blocked: 0,
    },
    phase: {},
    convergence: {},
  };

  for (const run of runs) {
    summary.status[run.status] = (summary.status[run.status] ?? 0) + 1;
    const phase = run.phase ?? 'unknown';
    summary.phase[phase] = (summary.phase[phase] ?? 0) + 1;
    const convergence = run.convergence?.status ?? 'unknown';
    summary.convergence[convergence] = (summary.convergence[convergence] ?? 0) + 1;
    if (convergence === 'blocked' || convergence === 'waiting_for_user') {
      summary.status.blocked += 1;
    }
  }

  return summary;
}
