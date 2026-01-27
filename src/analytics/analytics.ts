import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Event, Phase } from '../events/schema';
import { readStateMetadata, type StateStore } from '../state/store';

export type AnalyticsFilters = {
  since?: string;
  until?: string;
  providers?: string[];
  repos?: string[];
};

export type AnalyticsSummary = {
  runsStarted: number;
  runsFinished: number;
  runsSuccess: number;
  runsFailed: number;
  runsCanceled: number;
  runsRunning: number;
  runsConverged: number;
  runsAborted: number;
  successRate: number;
  avgTimeToConvergenceMs: number | null;
};

export type AnalyticsPhaseSummary = {
  phase: Phase;
  avgDurationMs: number;
  totalDurationMs: number;
  sampleCount: number;
  failureCount: number;
  failureShare: number;
};

export type AnalyticsFailureSummary = {
  reason: string;
  count: number;
  phase?: Phase;
  sampleRuns: string[];
};

export type AnalyticsReport = {
  generatedAt: string;
  filters: AnalyticsFilters;
  summary: AnalyticsSummary;
  phases: AnalyticsPhaseSummary[];
  failures: AnalyticsFailureSummary[];
};

type AuditSource = {
  repoId?: string;
  repoLabel?: string;
  repoRoot?: string;
  auditDir: string;
};

type AuditLogFile = {
  runId: string;
  path: string;
  source: AuditSource;
};

type PhaseChange = { phase: Phase; ts: string };

type RunAnalytics = {
  runId: string;
  repoId?: string;
  repoLabel?: string;
  repoRoot?: string;
  taskId?: string;
  provider: string;
  startedAt?: string;
  finishedAt?: string;
  firstSeenAt?: string;
  status?: 'success' | 'failed' | 'canceled';
  durationMs?: number;
  failureReason?: string;
  failurePhase?: Phase;
  phaseDurations: Record<string, number>;
};

const PHASE_ORDER: Phase[] = [
  'idle',
  'worktree',
  'plan',
  'implement',
  'verify',
  'pr',
  'ci',
  'review',
  'complete',
  'failed',
  'canceled',
];

export async function buildAnalyticsReport(options: {
  state: StateStore;
  filters?: AnalyticsFilters;
  now?: Date;
}): Promise<AnalyticsReport> {
  const now = options.now ?? new Date();
  const filters = normalizeFilters(options.filters);
  const sources = await collectAuditSources(options.state);
  const auditFiles = await listAuditFiles(sources);
  const runs: RunAnalytics[] = [];

  for (const file of auditFiles) {
    const events = await readAuditLogEvents(file.path);
    if (events.length === 0) continue;
    const run = buildRunAnalytics(file.runId, file.source, events);
    if (!matchesFilters(run, filters)) continue;
    runs.push(run);
  }

  const summary = buildSummary(runs);
  const phases = buildPhaseSummary(runs);
  const failures = buildFailureSummary(runs);

  return {
    generatedAt: now.toISOString(),
    filters,
    summary,
    phases,
    failures,
  };
}

function normalizeFilters(filters?: AnalyticsFilters): AnalyticsFilters {
  if (!filters) return {};
  const providers = filters.providers?.map((provider) => provider.toLowerCase());
  const repos = filters.repos?.map((repo) => repo.toLowerCase());
  return {
    ...(filters.since ? { since: filters.since } : {}),
    ...(filters.until ? { until: filters.until } : {}),
    ...(providers && providers.length > 0 ? { providers } : {}),
    ...(repos && repos.length > 0 ? { repos } : {}),
  };
}

function buildSummary(runs: RunAnalytics[]): AnalyticsSummary {
  const runsFinished = runs.filter((run) => run.status !== undefined).length;
  const runsSuccess = runs.filter((run) => run.status === 'success').length;
  const runsFailed = runs.filter((run) => run.status === 'failed').length;
  const runsCanceled = runs.filter((run) => run.status === 'canceled').length;
  const runsRunning = runs.length - runsFinished;
  const successDurations = runs
    .filter((run) => run.status === 'success')
    .map((run) => run.durationMs)
    .filter((duration): duration is number => typeof duration === 'number');
  const avgTimeToConvergenceMs =
    successDurations.length === 0
      ? null
      : successDurations.reduce((sum, duration) => sum + duration, 0) /
        successDurations.length;

  return {
    runsStarted: runs.length,
    runsFinished,
    runsSuccess,
    runsFailed,
    runsCanceled,
    runsRunning,
    runsConverged: runsSuccess,
    runsAborted: runsCanceled,
    successRate: runsFinished === 0 ? 0 : runsSuccess / runsFinished,
    avgTimeToConvergenceMs,
  };
}

function buildPhaseSummary(runs: RunAnalytics[]): AnalyticsPhaseSummary[] {
  const totals = new Map<
    Phase,
    { totalDurationMs: number; sampleCount: number; failureCount: number }
  >();
  const totalFailures = runs.filter((run) => run.status === 'failed').length;

  for (const run of runs) {
    for (const [phase, durationMs] of Object.entries(run.phaseDurations)) {
      if (!PHASE_ORDER.includes(phase as Phase)) continue;
      const key = phase as Phase;
      const entry = totals.get(key) ?? {
        totalDurationMs: 0,
        sampleCount: 0,
        failureCount: 0,
      };
      entry.totalDurationMs += durationMs;
      entry.sampleCount += 1;
      totals.set(key, entry);
    }

    if (run.status === 'failed' && run.failurePhase) {
      const entry = totals.get(run.failurePhase) ?? {
        totalDurationMs: 0,
        sampleCount: 0,
        failureCount: 0,
      };
      entry.failureCount += 1;
      totals.set(run.failurePhase, entry);
    }
  }

  return PHASE_ORDER.filter((phase) => totals.has(phase)).map((phase) => {
    const entry = totals.get(phase)!;
    const avgDurationMs =
      entry.sampleCount === 0 ? 0 : entry.totalDurationMs / entry.sampleCount;
    const failureShare = totalFailures === 0 ? 0 : entry.failureCount / totalFailures;
    return {
      phase,
      avgDurationMs,
      totalDurationMs: entry.totalDurationMs,
      sampleCount: entry.sampleCount,
      failureCount: entry.failureCount,
      failureShare,
    };
  });
}

function buildFailureSummary(runs: RunAnalytics[]): AnalyticsFailureSummary[] {
  const summary = new Map<
    string,
    { count: number; sampleRuns: string[]; phaseCounts: Map<Phase, number> }
  >();

  for (const run of runs) {
    if (run.status !== 'failed') continue;
    const reason = run.failureReason ?? 'unknown';
    const entry = summary.get(reason) ?? {
      count: 0,
      sampleRuns: [] as string[],
      phaseCounts: new Map<Phase, number>(),
    };
    entry.count += 1;
    if (entry.sampleRuns.length < 3) {
      entry.sampleRuns.push(run.runId);
    }
    if (run.failurePhase) {
      const nextCount = (entry.phaseCounts.get(run.failurePhase) ?? 0) + 1;
      entry.phaseCounts.set(run.failurePhase, nextCount);
    }
    summary.set(reason, entry);
  }

  return [...summary.entries()]
    .map(([reason, entry]) => {
      const phase = pickTopPhase(entry.phaseCounts);
      return {
        reason,
        count: entry.count,
        ...(phase ? { phase } : {}),
        sampleRuns: entry.sampleRuns,
      };
    })
    .sort((a, b) => b.count - a.count);
}

function pickTopPhase(phaseCounts: Map<Phase, number>): Phase | undefined {
  let topPhase: Phase | undefined;
  let topCount = 0;
  for (const [phase, count] of phaseCounts.entries()) {
    if (count > topCount) {
      topPhase = phase;
      topCount = count;
    }
  }
  return topPhase;
}

function matchesFilters(run: RunAnalytics, filters: AnalyticsFilters): boolean {
  if (filters.providers && filters.providers.length > 0) {
    if (!filters.providers.includes(run.provider.toLowerCase())) {
      return false;
    }
  }

  if (filters.repos && filters.repos.length > 0) {
    const repoLabel = run.repoLabel?.toLowerCase();
    const repoRoot = run.repoRoot?.toLowerCase();
    const repoId = run.repoId?.toLowerCase();
    const matchesRepo = filters.repos.some((filter) => {
      const needle = filter.toLowerCase();
      return (
        (repoLabel && repoLabel.includes(needle)) ||
        (repoRoot && repoRoot.includes(needle)) ||
        (repoId && repoId === needle)
      );
    });
    if (!matchesRepo) return false;
  }

  if (filters.since || filters.until) {
    const timestamp = run.startedAt ?? run.firstSeenAt ?? run.finishedAt;
    if (!timestamp) return false;
    if (filters.since && timestamp < filters.since) return false;
    if (filters.until && timestamp > filters.until) return false;
  }

  return true;
}

function buildRunAnalytics(
  runId: string,
  source: AuditSource,
  events: Event[],
): RunAnalytics {
  let startedAt: string | undefined;
  let finishedAt: string | undefined;
  let firstSeenAt: string | undefined;
  let status: RunAnalytics['status'];
  let durationMs: number | undefined;
  let failureReason: string | undefined;
  let failurePhase: Phase | undefined;
  let taskId: string | undefined;
  const phaseChanges: PhaseChange[] = [];

  for (const event of events) {
    if (!firstSeenAt || event.ts < firstSeenAt) {
      firstSeenAt = event.ts;
    }
    if (!taskId && event.taskId) {
      taskId = event.taskId;
    }
    switch (event.type) {
      case 'run.started':
        startedAt = event.ts;
        break;
      case 'run.phase_changed':
        phaseChanges.push({ phase: event.payload.to, ts: event.ts });
        break;
      case 'run.finished':
        finishedAt = event.ts;
        status = event.payload.status;
        durationMs = event.payload.durationMs;
        if (status === 'failed') {
          failureReason = event.error?.code ?? event.error?.message;
        }
        break;
      default:
        break;
    }
  }

  if (status === 'failed' && !failureReason) {
    failureReason = 'unknown';
  }

  const phaseDurations = computePhaseDurations(phaseChanges, finishedAt);
  if (status === 'failed' && phaseChanges.length > 0) {
    failurePhase = phaseChanges[phaseChanges.length - 1]?.phase;
  }

  if (durationMs === undefined && startedAt && finishedAt) {
    const startMs = parseTimestamp(startedAt);
    const endMs = parseTimestamp(finishedAt);
    if (startMs !== null && endMs !== null) {
      durationMs = Math.max(0, endMs - startMs);
    }
  }

  return {
    runId,
    ...(source.repoId ? { repoId: source.repoId } : {}),
    ...(source.repoLabel ? { repoLabel: source.repoLabel } : {}),
    ...(source.repoRoot ? { repoRoot: source.repoRoot } : {}),
    ...(taskId ? { taskId } : {}),
    provider: inferProvider(taskId),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(firstSeenAt ? { firstSeenAt } : {}),
    ...(status ? { status } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(failurePhase ? { failurePhase } : {}),
    phaseDurations,
  };
}

function inferProvider(taskId: string | undefined): string {
  if (!taskId) return 'local';
  const normalized = taskId.toLowerCase();
  if (normalized.startsWith('gh-')) return 'github';
  if (/^[a-z]{2,10}-\d+$/i.test(taskId)) return 'linear';
  return 'local';
}

function computePhaseDurations(
  changes: PhaseChange[],
  finishedAt: string | undefined,
): Record<string, number> {
  if (changes.length === 0) return {};
  const sorted = [...changes].sort((a, b) => a.ts.localeCompare(b.ts));
  const durations: Record<string, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    if (!current) continue;
    const next = sorted[index + 1];
    const startMs = parseTimestamp(current.ts);
    const endMs = parseTimestamp(next?.ts ?? finishedAt);
    if (startMs === null || endMs === null) continue;
    const delta = Math.max(0, endMs - startMs);
    durations[current.phase] = (durations[current.phase] ?? 0) + delta;
  }
  return durations;
}

async function collectAuditSources(state: StateStore): Promise<AuditSource[]> {
  const base = state.root;
  if (basename(base) === '.silvan') {
    const metadataPath = join(base, 'metadata.json');
    const repoRootFallback = dirname(base);
    const metadata = await readRepoMetadata(metadataPath, basename(repoRootFallback));
    return [
      {
        auditDir: state.auditDir,
        repoLabel: metadata.label,
        repoRoot: metadata.repoRoot ?? repoRootFallback,
      },
    ];
  }

  const repoBase = dirname(base);
  const dataRoot = basename(repoBase) === 'repos' ? dirname(repoBase) : base;
  const globalReposDir = join(dataRoot, 'repos');
  let repoIds: string[] = [];
  try {
    repoIds = await readdir(globalReposDir);
  } catch {
    const metadataPath = join(base, 'metadata.json');
    const metadata = await readRepoMetadata(metadataPath, 'current');
    return [
      {
        auditDir: state.auditDir,
        repoLabel: metadata.label,
        ...(metadata.repoRoot ? { repoRoot: metadata.repoRoot } : {}),
      },
    ];
  }

  const sources: AuditSource[] = [];
  for (const repoId of repoIds) {
    const repoRoot = join(globalReposDir, repoId);
    const metadataPath = join(repoRoot, 'metadata.json');
    const metadata = await readRepoMetadata(metadataPath, repoId);
    sources.push({
      repoId,
      repoLabel: metadata.label,
      ...(metadata.repoRoot ? { repoRoot: metadata.repoRoot } : {}),
      auditDir: join(repoRoot, 'audit'),
    });
  }
  return sources;
}

async function listAuditFiles(sources: AuditSource[]): Promise<AuditLogFile[]> {
  const files: AuditLogFile[] = [];
  for (const source of sources) {
    let entries: string[] = [];
    try {
      entries = await readdir(source.auditDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const runId = entry.replace(/\.jsonl$/, '');
      files.push({
        runId,
        path: join(source.auditDir, entry),
        source,
      });
    }
  }
  return files;
}

async function readRepoMetadata(
  metadataPath: string,
  fallback: string,
): Promise<{ label: string; repoRoot?: string }> {
  try {
    const metadata = await readStateMetadata(metadataPath);
    const label =
      typeof metadata.repoLabel === 'string' && metadata.repoLabel.length > 0
        ? metadata.repoLabel
        : fallback;
    const repoRoot =
      typeof metadata.repoRoot === 'string' && metadata.repoRoot.length > 0
        ? metadata.repoRoot
        : undefined;
    return { label, ...(repoRoot ? { repoRoot } : {}) };
  } catch {
    return { label: fallback };
  }
}

async function readAuditLogEvents(path: string): Promise<Event[]> {
  let raw = '';
  try {
    raw = await Bun.file(path).text();
  } catch {
    return [];
  }

  const trimmed = raw.trim();
  if (!trimmed) return [];
  const lines = trimmed.split('\n');
  const events: Event[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Event);
    } catch {
      continue;
    }
  }
  return events;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
