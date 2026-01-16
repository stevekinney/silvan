import type { CiState, Phase, StepStatus } from '../events/schema';
import type { RunSnapshot } from './loader';
import type {
  AllEvents,
  DashboardState,
  RunRecord,
  RunStatus,
  RunStepSummary,
} from './types';
import { initialDashboardState } from './types';

const DEFAULT_RUN_LIMIT = 25;
const STUCK_LEASE_MS = 2 * 60 * 1000;

export function reduceDashboard(state: DashboardState, event: AllEvents): DashboardState {
  switch (event.type) {
    case 'run.started':
      return upsertRun(state, {
        runId: event.payload.runId,
        repoId: event.repoId,
        repoLabel: event.repoId,
        status: 'running',
        phase: 'idle',
        updatedAt: event.ts,
      });
    case 'run.phase_changed': {
      const run =
        state.runs[event.runId] ?? createRunStub(event.runId, event.repoId, event.ts);
      return upsertRun(state, {
        ...run,
        phase: event.payload.to,
        updatedAt: event.ts,
      });
    }
    case 'run.step': {
      const run =
        state.runs[event.runId] ?? createRunStub(event.runId, event.repoId, event.ts);
      const step = updateStep(run.steps, event.payload, event.ts);
      return upsertRun(state, {
        ...run,
        step: step.current,
        steps: step.steps,
        updatedAt: event.ts,
        ...(event.payload.status === 'failed'
          ? {
              lastError: {
                message: `Step failed: ${event.payload.title}`,
                source: event.source,
                stepId: event.payload.stepId,
                ts: event.ts,
              },
              status: 'failed',
            }
          : {}),
      });
    }
    case 'run.finished': {
      const run = state.runs[event.runId];
      if (!run) return state;
      const status: RunStatus =
        event.payload.status === 'success'
          ? 'success'
          : event.payload.status === 'failed'
            ? 'failed'
            : event.payload.status === 'canceled'
              ? 'canceled'
              : 'unknown';
      return upsertRun(state, {
        ...run,
        status,
        finishedAt: event.ts,
        updatedAt: event.ts,
      });
    }
    case 'github.pr_opened_or_updated': {
      const run =
        state.runs[event.runId] ?? createRunStub(event.runId, event.repoId, event.ts);
      const pr = {
        id: `${event.payload.pr.owner}/${event.payload.pr.repo}#${event.payload.pr.number}`,
        ...(event.payload.pr.url ? { url: event.payload.pr.url } : {}),
      };
      return upsertRun(state, {
        ...run,
        pr,
        updatedAt: event.ts,
      });
    }
    case 'ci.status': {
      const run =
        state.runs[event.runId] ?? createRunStub(event.runId, event.repoId, event.ts);
      return upsertRun(state, {
        ...run,
        ci: {
          state: event.payload.state,
          ...(event.payload.summary ? { summary: event.payload.summary } : {}),
        },
        updatedAt: event.ts,
      });
    }
    case 'github.review_comments_fetched': {
      const run =
        state.runs[event.runId] ?? createRunStub(event.runId, event.repoId, event.ts);
      const iteration = run.review?.iteration;
      return upsertRun(state, {
        ...run,
        review: {
          unresolvedCount: event.payload.unresolvedCount,
          ...(typeof iteration === 'number' ? { iteration } : {}),
        },
        updatedAt: event.ts,
      });
    }
    case 'github.prs_snapshot': {
      return {
        ...state,
        openPrs: event.payload.prs,
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
    default: {
      if (event.level === 'error') {
        const run =
          state.runs[event.runId] ?? createRunStub(event.runId, event.repoId, event.ts);
        return upsertRun(state, {
          ...run,
          lastError: {
            message: event.error?.message ?? event.message ?? 'Unknown error',
            source: event.source,
            ts: event.ts,
          },
          status: run.status === 'unknown' ? 'failed' : run.status,
          updatedAt: event.ts,
        });
      }
      return state;
    }
  }
}

export function applyDashboardEvent(
  state: DashboardState,
  event: AllEvents,
): DashboardState {
  return reduceDashboard(state, event);
}

export function applyRunSnapshots(
  state: DashboardState,
  snapshots: RunSnapshot[],
): DashboardState {
  let next = state;
  for (const snapshot of snapshots) {
    next = upsertRun(next, deriveRunFromSnapshot(snapshot));
  }
  return next;
}

export function createDashboardState(): DashboardState {
  return initialDashboardState();
}

function upsertRun(state: DashboardState, run: RunRecord): DashboardState {
  const runs = { ...state.runs, [run.runId]: run };
  const runIndex = buildRunIndex(runs, DEFAULT_RUN_LIMIT);
  const selection = state.selection ?? runIndex[0];
  return {
    ...state,
    runs,
    runIndex,
    ...(selection ? { selection } : {}),
  };
}

function createRunStub(runId: string, repoId: string, ts: string): RunRecord {
  return {
    runId,
    repoId,
    repoLabel: repoId,
    status: 'running',
    phase: 'idle',
    updatedAt: ts,
  };
}

function buildRunIndex(runs: Record<string, RunRecord>, limit: number): string[] {
  return Object.values(runs)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((run) => run.runId);
}

function updateStep(
  steps: RunStepSummary[] | undefined,
  payload: { stepId: string; title: string; status: StepStatus },
  ts: string,
): { current: RunStepSummary; steps: RunStepSummary[] } {
  const existing = steps ?? [];
  const index = existing.findIndex((step) => step.stepId === payload.stepId);
  const startedAt = payload.status === 'running' ? ts : existing[index]?.startedAt;
  const endedAt =
    payload.status === 'succeeded' || payload.status === 'failed'
      ? ts
      : existing[index]?.endedAt;
  const next: RunStepSummary = {
    stepId: payload.stepId,
    title: payload.title,
    status: payload.status,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
  };
  const nextSteps = [...existing];
  if (index >= 0) {
    nextSteps[index] = { ...existing[index], ...next };
  } else {
    nextSteps.push(next);
  }
  return { current: next, steps: nextSteps };
}

function deriveRunFromSnapshot(snapshot: RunSnapshot): RunRecord {
  const data = snapshot.data;
  const runMeta = typeof data['run'] === 'object' && data['run'] ? data['run'] : {};
  const stepsRecord: Record<string, StepRecord> =
    typeof data['steps'] === 'object' && data['steps']
      ? (data['steps'] as Record<string, StepRecord>)
      : {};
  const summary =
    typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {};
  const prData = typeof data['pr'] === 'object' && data['pr'] ? data['pr'] : undefined;
  const task = typeof data['task'] === 'object' && data['task'] ? data['task'] : {};
  const taskProvider =
    typeof (task as { provider?: string }).provider === 'string'
      ? (task as { provider?: string }).provider
      : undefined;
  const taskUrl =
    typeof (task as { url?: string }).url === 'string'
      ? (task as { url?: string }).url
      : undefined;

  const phase = (runMeta as { phase?: Phase }).phase ?? 'idle';
  const status = mapRunStatus((runMeta as { status?: string }).status);
  const stepId = (runMeta as { step?: string }).step;

  const stepSummaries = mapStepSummaries(stepsRecord);
  const currentStep = stepId
    ? stepSummaries.find((step) => step.stepId === stepId)
    : undefined;

  const lastFailed = [...stepSummaries]
    .filter((step) => step.status === 'failed')
    .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0];
  const lastFailedMessage =
    lastFailed && stepsRecord[lastFailed.stepId]?.error?.message
      ? stepsRecord[lastFailed.stepId]?.error?.message
      : undefined;

  const verifySummary = data['verifySummary'] as
    | { ok?: boolean; lastRunAt?: string }
    | undefined;
  const reviewVerifySummary = data['reviewVerifySummary'] as
    | { ok?: boolean; lastRunAt?: string }
    | undefined;
  const reviewClassificationSummary = data['reviewClassificationSummary'] as
    | { actionable?: number; ignored?: number; needsContext?: number }
    | undefined;
  const reviewFixPlanSummary = data['reviewFixPlanSummary'] as
    | { actionable?: number; ignored?: number }
    | undefined;
  const verificationDecisionSummary = data['verificationDecisionSummary'] as
    | { commands?: string[]; askUser?: boolean }
    | undefined;
  const recoverySummary = data['recoverySummary'] as
    | { nextAction?: string; reason?: string }
    | undefined;
  const verifyStepRecord = stepsRecord['verify.run'];
  const verifyRunAt =
    verifySummary?.lastRunAt ?? verifyStepRecord?.endedAt ?? verifyStepRecord?.startedAt;
  const reviewIteration =
    typeof data['reviewIteration'] === 'number' ? data['reviewIteration'] : undefined;
  const toolCallSummary = data['toolCallSummary'] as
    | { total?: number; failed?: number }
    | undefined;
  const checkpoints = Array.isArray(data['checkpoints'])
    ? (data['checkpoints'] as string[])
    : undefined;
  const ciState = (summary as { ci?: CiState }).ci;
  const prUrl =
    typeof (summary as { prUrl?: string }).prUrl === 'string'
      ? (summary as { prUrl?: string }).prUrl
      : undefined;
  const prInfo = prData as
    | { url?: string; number?: number; owner?: string; repo?: string }
    | undefined;
  const unresolvedValue = (summary as { unresolvedReviewCount?: number })
    .unresolvedReviewCount;
  const unresolved: number = typeof unresolvedValue === 'number' ? unresolvedValue : 0;
  const blockedReason =
    typeof (summary as { blockedReason?: string }).blockedReason === 'string'
      ? (summary as { blockedReason?: string }).blockedReason
      : undefined;
  const promptSummaries = data['promptSummaries'] as Record<string, string> | undefined;

  const stuck = detectStuck(stepId, stepsRecord, snapshot.updatedAt);

  return {
    runId: snapshot.runId,
    ...(snapshot.repoId ? { repoId: snapshot.repoId } : {}),
    ...(snapshot.repoLabel ? { repoLabel: snapshot.repoLabel } : {}),
    status,
    phase,
    ...(currentStep ? { step: currentStep } : {}),
    ...(stepSummaries.length > 0 ? { steps: stepSummaries } : {}),
    ...((prInfo?.number && prInfo?.owner && prInfo?.repo
      ? {
          pr: {
            id: `${prInfo.owner}/${prInfo.repo}#${prInfo.number}`,
            ...(prInfo.url ? { url: prInfo.url } : {}),
          },
        }
      : prUrl
        ? { pr: { id: 'PR', url: prUrl } }
        : {}) as Partial<Pick<RunRecord, 'pr'>>),
    ...(ciState ? { ci: { state: ciState } } : {}),
    review: {
      unresolvedCount: unresolved,
      ...(typeof reviewIteration === 'number' ? { iteration: reviewIteration } : {}),
    },
    ...(checkpoints ? { checkpoints } : {}),
    ...(verifySummary?.ok !== undefined
      ? {
          verification: {
            ok: verifySummary.ok,
            ...(verifyRunAt ? { lastRunAt: verifyRunAt } : {}),
          },
        }
      : {}),
    ...(reviewVerifySummary?.ok !== undefined
      ? {
          reviewVerification: {
            ok: reviewVerifySummary.ok,
            ...(reviewVerifySummary.lastRunAt
              ? { lastRunAt: reviewVerifySummary.lastRunAt }
              : {}),
          },
        }
      : {}),
    ...(reviewClassificationSummary
      ? {
          reviewClassification: {
            actionable: reviewClassificationSummary.actionable ?? 0,
            ignored: reviewClassificationSummary.ignored ?? 0,
            needsContext: reviewClassificationSummary.needsContext ?? 0,
          },
        }
      : {}),
    ...(reviewFixPlanSummary
      ? {
          reviewFixPlan: {
            actionable: reviewFixPlanSummary.actionable ?? 0,
            ignored: reviewFixPlanSummary.ignored ?? 0,
          },
        }
      : {}),
    ...(verificationDecisionSummary
      ? {
          verificationDecision: {
            commands: verificationDecisionSummary.commands ?? [],
            askUser: verificationDecisionSummary.askUser ?? false,
          },
        }
      : {}),
    ...(recoverySummary?.nextAction
      ? {
          recoverySummary: {
            nextAction: recoverySummary.nextAction,
            reason: recoverySummary.reason ?? '',
          },
        }
      : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(promptSummaries ? { promptSummaries: Object.values(promptSummaries) } : {}),
    ...(typeof toolCallSummary?.total === 'number'
      ? {
          toolCalls: {
            total: toolCallSummary.total,
            ...(typeof toolCallSummary.failed === 'number'
              ? { failed: toolCallSummary.failed }
              : {}),
          },
        }
      : {}),
    ...(typeof (task as { id?: string }).id === 'string'
      ? { taskId: (task as { id?: string }).id }
      : {}),
    ...(typeof (task as { key?: string }).key === 'string'
      ? { taskKey: (task as { key?: string }).key }
      : {}),
    ...(typeof (task as { title?: string }).title === 'string'
      ? { taskTitle: (task as { title?: string }).title }
      : {}),
    ...(taskProvider ? { taskProvider } : {}),
    ...(taskUrl ? { taskUrl } : {}),
    ...(lastFailed
      ? {
          lastError: {
            message: lastFailedMessage ?? `Step failed: ${lastFailed.stepId}`,
            stepId: lastFailed.stepId,
            ...(lastFailed.endedAt ? { ts: lastFailed.endedAt } : {}),
          },
        }
      : {}),
    ...(stuck ? { stuck } : {}),
    updatedAt: snapshot.updatedAt,
    ...((runMeta as { startedAt?: string }).startedAt
      ? { startedAt: (runMeta as { startedAt?: string }).startedAt }
      : {}),
    ...((runMeta as { finishedAt?: string }).finishedAt
      ? { finishedAt: (runMeta as { finishedAt?: string }).finishedAt }
      : {}),
  };
}

type StepRecord = {
  status?: StepStatus;
  startedAt?: string;
  endedAt?: string;
  error?: { message?: string };
  lease?: { leaseId?: string; heartbeatAt?: string; startedAt?: string };
};

function mapRunStatus(value: string | undefined): RunStatus {
  switch (value) {
    case 'running':
    case 'success':
    case 'failed':
    case 'canceled':
      return value;
    default:
      return 'unknown';
  }
}

function mapStepSummaries(steps: Record<string, StepRecord>): RunStepSummary[] {
  return Object.entries(steps).map(([stepId, record]) => ({
    stepId,
    status: record.status ?? 'queued',
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
  }));
}

function detectStuck(
  stepId: string | undefined,
  steps: Record<string, StepRecord>,
  nowIso: string,
): { reason: string; since?: string } | undefined {
  if (!stepId) return undefined;
  const record = steps[stepId];
  if (!record || record.status !== 'running') return undefined;
  const heartbeat = record.lease?.heartbeatAt ?? record.startedAt;
  if (!heartbeat) return { reason: 'running without heartbeat' };
  const now = Date.parse(nowIso);
  const last = Date.parse(heartbeat);
  if (Number.isFinite(now) && Number.isFinite(last) && now - last > STUCK_LEASE_MS) {
    return { reason: 'lease stale', since: heartbeat };
  }
  return undefined;
}
