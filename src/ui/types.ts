import type { CiState, Event, Phase, StepStatus } from '../events/schema';

export type RunStatus = 'running' | 'success' | 'failed' | 'canceled' | 'unknown';

export type RunStepSummary = {
  stepId: string;
  title?: string;
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
};

export type RunError = {
  message: string;
  source?: string;
  stepId?: string;
  ts?: string;
};

export type RunRecord = {
  runId: string;
  repoId?: string;
  repoLabel?: string;
  status: RunStatus;
  phase: Phase;
  step?: RunStepSummary;
  steps?: RunStepSummary[];
  pr?: {
    id: string;
    url?: string;
  };
  ci?: {
    state: CiState;
    summary?: string;
  };
  review?: {
    unresolvedCount: number;
    iteration?: number;
  };
  verification?: {
    ok?: boolean;
    lastRunAt?: string;
  };
  toolCalls?: {
    total: number;
    failed?: number;
  };
  taskId?: string;
  taskTitle?: string;
  lastError?: RunError;
  lastMessage?: string;
  stuck?: {
    reason: string;
    since?: string;
  };
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type DashboardState = {
  runs: Record<string, RunRecord>;
  runIndex: string[];
  selection?: string;
  filter: { query: string };
  helpVisible: boolean;
  worktrees: Array<{
    id: string;
    path: string;
    branch?: string;
    pr?: { id: string; ci: CiState; unresolvedReviewCount: number };
  }>;
  openPrs: Array<{
    id: string;
    title: string;
    url?: string;
    headBranch: string;
    baseBranch: string;
    ci: CiState;
    unresolvedReviewCount: number;
  }>;
};

export type AllEvents = Event;

export function initialDashboardState(): DashboardState {
  return {
    runs: {},
    runIndex: [],
    filter: { query: '' },
    helpVisible: false,
    worktrees: [],
    openPrs: [],
  };
}
