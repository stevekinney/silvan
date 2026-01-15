import type { AllEvents, DashboardState } from './types';
import { initialDashboardState } from './types';

export function reduceDashboard(state: DashboardState, event: AllEvents): DashboardState {
  switch (event.type) {
    case 'run.started':
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.payload.runId]: {
            runId: event.payload.runId,
            phase: 'idle',
            updatedAt: event.ts,
          },
        },
      };
    case 'run.phase_changed': {
      const run = state.runs[event.runId];
      if (!run) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.runId]: {
            ...run,
            phase: event.payload.to,
            updatedAt: event.ts,
          },
        },
      };
    }
    case 'run.step': {
      const run = state.runs[event.runId];
      if (!run) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.runId]: {
            ...run,
            step: {
              stepId: event.payload.stepId,
              title: event.payload.title,
              status: event.payload.status,
            },
            updatedAt: event.ts,
          },
        },
      };
    }
    case 'github.pr_opened_or_updated': {
      const run = state.runs[event.runId];
      if (!run) return state;
      const pr = {
        id: `${event.payload.pr.owner}/${event.payload.pr.repo}#${event.payload.pr.number}`,
        ci: 'unknown' as const,
        unresolvedReviewCount: 0,
        ...(event.payload.pr.url ? { url: event.payload.pr.url } : {}),
      };
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.runId]: {
            ...run,
            pr,
            updatedAt: event.ts,
          },
        },
      };
    }
    case 'ci.status': {
      const run = state.runs[event.runId];
      if (!run || !run.pr) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.runId]: {
            ...run,
            pr: {
              ...run.pr,
              ci: event.payload.state,
            },
            updatedAt: event.ts,
          },
        },
      };
    }
    case 'github.review_comments_fetched': {
      const run = state.runs[event.runId];
      if (!run || !run.pr) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.runId]: {
            ...run,
            pr: {
              ...run.pr,
              unresolvedReviewCount: event.payload.unresolvedCount,
            },
            updatedAt: event.ts,
          },
        },
      };
    }
    case 'worktree.listed': {
      return {
        ...state,
        worktrees: event.payload.worktrees.map((worktree) => ({
          id: worktree.id,
          path: worktree.path,
          ...(worktree.branch ? { branch: worktree.branch } : {}),
        })),
      };
    }
    default:
      return state;
  }
}

export function applyDashboardEvent(
  state: DashboardState,
  event: AllEvents,
): DashboardState {
  return reduceDashboard(state, event);
}

export function createDashboardState(): DashboardState {
  return initialDashboardState();
}
