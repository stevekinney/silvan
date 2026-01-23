import type { CiState, Event, Phase, StepStatus } from '../events/schema';
import type { RunConvergence } from '../run/convergence';

export type RunStatus = 'running' | 'success' | 'failed' | 'canceled' | 'unknown';

export type RunStepSummary = {
  stepId: string;
  title?: string;
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
  error?: string;
};

export type RunError = {
  message: string;
  source?: string;
  stepId?: string;
  ts?: string;
};

export type RunEventSummary = {
  eventCount: number;
  latestEventAt?: string;
};

export type RunRecord = {
  runId: string;
  repoId?: string;
  repoLabel?: string;
  worktree?: {
    path: string;
    branch?: string;
  };
  status: RunStatus;
  phase: Phase;
  step?: RunStepSummary;
  steps?: RunStepSummary[];
  checkpoints?: string[];
  pr?: {
    id: string;
    url?: string;
    title?: string;
    headBranch?: string;
    baseBranch?: string;
    action?: 'opened' | 'updated' | 'noop';
  };
  ci?: {
    state: CiState;
    summary?: string;
    checks?: Array<{
      name: string;
      state: 'queued' | 'in_progress' | 'completed';
      conclusion?: string;
      url?: string;
    }>;
  };
  review?: {
    unresolvedCount: number;
    iteration?: number;
    totalCount?: number;
  };
  reviewClassification?: {
    actionable: number;
    ignored: number;
    needsContext: number;
    severity?: {
      blocking: number;
      question: number;
      suggestion: number;
      nitpick: number;
    };
    autoResolved?: number;
  };
  reviewFixPlan?: {
    actionable: number;
    ignored: number;
  };
  verification?: {
    ok?: boolean;
    lastRunAt?: string;
  };
  reviewVerification?: {
    ok?: boolean;
    lastRunAt?: string;
  };
  verificationDecision?: {
    commands: string[];
    askUser: boolean;
  };
  localGate?: {
    ok: boolean;
    blockers: number;
    warnings: number;
    generatedAt?: string;
  };
  aiReview?: {
    shipIt: boolean;
    issues: number;
  };
  ciFixSummary?: {
    summary?: string;
    steps?: number;
  };
  learning?: {
    summary: string;
    rules: number;
    skills: number;
    docs: number;
    mode: string;
    appliedTo?: string[];
    status?: string;
    confidence?: number;
    threshold?: number;
    autoApplied?: boolean;
    commitSha?: string;
    decisionReason?: string;
  };
  recoverySummary?: {
    nextAction: string;
    reason: string;
  };
  toolCalls?: {
    total: number;
    failed?: number;
  };
  eventCount?: number;
  latestEventAt?: string;
  taskId?: string;
  taskKey?: string;
  taskTitle?: string;
  taskProvider?: string;
  taskUrl?: string;
  blockedReason?: string;
  promptSummaries?: string[];
  convergence?: RunConvergence;
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

export type QueueRecord = {
  id: string;
  title: string;
  description?: string;
  priority: number;
  effectivePriority: number;
  priorityBoost?: number;
  priorityTier?: 'high' | 'medium' | 'low';
  ageMinutes?: number;
  createdAt: string;
  repoId?: string;
  repoLabel?: string;
};

export type WorktreeRecord = {
  id: string;
  path: string;
  relativePath?: string;
  branch?: string;
  headSha?: string;
  isBare?: boolean;
  isLocked?: boolean;
  isDirty?: boolean;
  repoId?: string;
  repoLabel?: string;
  lastActivityAt?: string;
};

export type DashboardState = {
  runs: Record<string, RunRecord>;
  runIndex: string[];
  selection?: string;
  filter: {
    query: string;
    status: string[];
    phase: string[];
    convergence: string[];
    provider: string[];
    repo: string[];
    task: string[];
    pr: string[];
  };
  helpVisible: boolean;
  queueRequests: QueueRecord[];
  worktrees: WorktreeRecord[];
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
    filter: {
      query: '',
      status: [],
      phase: [],
      convergence: [],
      provider: [],
      repo: [],
      task: [],
      pr: [],
    },
    helpVisible: false,
    queueRequests: [],
    worktrees: [],
    openPrs: [],
  };
}
