import type { CiState, Event, Phase, StepStatus } from '../events/schema';

export type DashboardState = {
  runs: Record<
    string,
    {
      runId: string;
      phase: Phase;
      step?: { stepId: string; title: string; status: StepStatus };
      pr?: { id: string; url?: string; ci: CiState; unresolvedReviewCount: number };
      ticketId?: string;
      lastMessage?: string;
      updatedAt: string;
    }
  >;
  worktrees: Array<{
    id: string;
    path: string;
    branch?: string;
    pr?: { id: string; ci: CiState; unresolvedReviewCount: number };
  }>;
};

export type AllEvents = Event;

export function initialDashboardState(): DashboardState {
  return {
    runs: {},
    worktrees: [],
  };
}
