import type { Event, Phase } from '../events/schema';
import type { RunRecord, RunStepSummary } from './types';

export type PhaseStatus =
  | 'completed'
  | 'running'
  | 'blocked'
  | 'failed'
  | 'pending'
  | 'skipped';

export type PhaseTimelineEntry = {
  phase: Phase;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  status: PhaseStatus;
};

export type StepStatus = 'completed' | 'running' | 'failed' | 'pending' | 'skipped';

export type StepHistoryEntry = {
  stepId: string;
  title: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
};

export const PHASE_ORDER: Phase[] = [
  'idle',
  'worktree',
  'plan',
  'implement',
  'verify',
  'pr',
  'ci',
  'review',
  'complete',
];

const BLOCKED_STATUSES = new Set([
  'blocked',
  'waiting_for_user',
  'waiting_for_ci',
  'waiting_for_review',
]);

export function buildPhaseTimeline(
  events: Event[],
  run: RunRecord,
  nowMs = Date.now(),
): PhaseTimelineEntry[] {
  const history = collectPhaseHistory(events, run);
  const currentPhase = resolveCurrentPhase(run, history);
  const currentIndex = PHASE_ORDER.indexOf(currentPhase);
  const isBlocked = BLOCKED_STATUSES.has(run.convergence?.status ?? '');

  return PHASE_ORDER.map((phase, index) => {
    const entry = history.get(phase);
    const startedAt = entry?.startedAt;
    const finishedAt = entry?.finishedAt;
    const durationMs = computeDurationMs(
      startedAt,
      finishedAt,
      nowMs,
      phase === currentPhase,
    );
    let status: PhaseStatus = 'pending';

    if (phase === currentPhase) {
      switch (run.status) {
        case 'failed': {
          status = 'failed';

          break;
        }
        case 'canceled': {
          status = 'skipped';

          break;
        }
        case 'success': {
          status = 'completed';

          break;
        }
        default:
          if (isBlocked) {
            status = 'blocked';
          } else {
            status = 'running';
          }
      }
    } else if (finishedAt) {
      status = 'completed';
    } else if (index < currentIndex) {
      status = 'completed';
    }

    return {
      phase,
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(typeof durationMs === 'number' ? { durationMs } : {}),
      status,
    };
  });
}

export function buildStepHistory(
  steps: RunStepSummary[] | undefined,
  events: Event[],
  nowMs = Date.now(),
): StepHistoryEntry[] {
  const entries = new Map<string, StepHistoryEntry>();
  const orderedEvents = [...events]
    .filter(
      (event): event is Extract<Event, { type: 'run.step' }> => event.type === 'run.step',
    )
    .sort((a, b) => a.ts.localeCompare(b.ts));

  for (const event of orderedEvents) {
    const { stepId, title, status } = event.payload;
    const entry =
      entries.get(stepId) ??
      ({
        stepId,
        title: title ?? stepId,
        status: 'pending',
      } as StepHistoryEntry);
    entry.title = title ?? entry.title ?? stepId;
    if (status === 'running' && !entry.startedAt) {
      entry.startedAt = event.ts;
    }
    if (status === 'succeeded' || status === 'failed' || status === 'skipped') {
      entry.finishedAt = event.ts;
    }
    entry.status = normalizeStepStatus(status);
    entries.set(stepId, entry);
  }

  if (steps) {
    for (const step of steps) {
      const entry =
        entries.get(step.stepId) ??
        ({
          stepId: step.stepId,
          title: step.title ?? step.stepId,
          status: normalizeStepStatus(step.status as string),
        } as StepHistoryEntry);
      if (step.title && entry.title === step.stepId) {
        entry.title = step.title;
      }
      if (step.startedAt && !entry.startedAt) {
        entry.startedAt = step.startedAt;
      }
      if (step.endedAt && !entry.finishedAt) {
        entry.finishedAt = step.endedAt;
      }
      if (step.error && !entry.error) {
        entry.error = step.error;
      }
      if (entry.status === 'pending' && step.status) {
        entry.status = normalizeStepStatus(step.status as string);
      }
      entries.set(step.stepId, entry);
    }
  }

  const history = Array.from(entries.values());
  for (const entry of history) {
    const durationMs = computeDurationMs(
      entry.startedAt,
      entry.finishedAt,
      nowMs,
      entry.status === 'running',
    );
    if (typeof durationMs === 'number') {
      entry.durationMs = durationMs;
    }
  }

  return history.sort((a, b) => {
    const aTime = getSortTimestamp(a.startedAt, a.finishedAt);
    const bTime = getSortTimestamp(b.startedAt, b.finishedAt);
    if (aTime !== bTime) return aTime - bTime;
    return a.stepId.localeCompare(b.stepId);
  });
}

function collectPhaseHistory(
  events: Event[],
  run: RunRecord,
): Map<Phase, { phase: Phase; startedAt?: string; finishedAt?: string }> {
  const history = new Map<
    Phase,
    { phase: Phase; startedAt?: string; finishedAt?: string }
  >();
  const transitions = [...events]
    .filter(
      (event): event is Extract<Event, { type: 'run.phase_changed' }> =>
        event.type === 'run.phase_changed',
    )
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const earliestEvent = [...events].sort((a, b) => a.ts.localeCompare(b.ts))[0];
  const start = run.startedAt ?? transitions[0]?.ts ?? earliestEvent?.ts ?? run.updatedAt;
  let current: Phase = transitions[0]?.payload.from ?? resolvePhase(run.phase) ?? 'idle';
  let currentStart = start;

  for (const transition of transitions) {
    const end = transition.ts;
    upsertPhase(history, current, currentStart, end);
    current = transition.payload.to;
    currentStart = end;
  }

  const terminalAt =
    run.finishedAt ?? (run.status !== 'running' ? run.updatedAt : undefined);
  upsertPhase(history, current, currentStart, terminalAt);
  return history;
}

function resolveCurrentPhase(
  run: RunRecord,
  history: Map<Phase, { phase: Phase; startedAt?: string; finishedAt?: string }>,
): Phase {
  const resolved = resolvePhase(run.phase);
  if (resolved) return resolved;
  const ordered = Array.from(history.values()).sort((a, b) =>
    (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
  );
  return ordered[ordered.length - 1]?.phase ?? 'idle';
}

function resolvePhase(phase: Phase | undefined): Phase | null {
  if (!phase) return null;
  return PHASE_ORDER.includes(phase) ? phase : null;
}

function normalizeStepStatus(status: string | undefined): StepStatus {
  switch (status) {
    case 'succeeded':
    case 'done':
      return 'completed';
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'queued':
    case 'not_started':
    default:
      return 'pending';
  }
}

function computeDurationMs(
  startedAt: string | undefined,
  finishedAt: string | undefined,
  nowMs: number,
  allowNow: boolean,
): number | undefined {
  const startMs = parseTimestamp(startedAt);
  if (startMs === null) return undefined;
  const endMs = parseTimestamp(finishedAt) ?? (allowNow ? nowMs : null);
  if (endMs === null) return undefined;
  return Math.max(0, endMs - startMs);
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function getSortTimestamp(startedAt?: string, finishedAt?: string): number {
  const start = parseTimestamp(startedAt);
  if (start !== null) return start;
  const finish = parseTimestamp(finishedAt);
  if (finish !== null) return finish;
  return Number.POSITIVE_INFINITY;
}

function upsertPhase(
  history: Map<Phase, { phase: Phase; startedAt?: string; finishedAt?: string }>,
  phase: Phase,
  startedAt?: string,
  finishedAt?: string,
): void {
  const existing = history.get(phase);
  if (!existing) {
    history.set(phase, buildPhaseEntry(phase, startedAt, finishedAt));
    return;
  }
  const nextStart = pickEarlier(existing.startedAt, startedAt);
  const nextEnd = pickLater(existing.finishedAt, finishedAt);
  history.set(phase, buildPhaseEntry(phase, nextStart, nextEnd));
}

function pickEarlier(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function pickLater(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function buildPhaseEntry(
  phase: Phase,
  startedAt?: string,
  finishedAt?: string,
): { phase: Phase; startedAt?: string; finishedAt?: string } {
  return {
    phase,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
  };
}
