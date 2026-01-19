import type { RunRecord } from './types';

export type SortKey = 'updated' | 'started' | 'duration';

export type GroupedRuns = {
  runs: RunRecord[];
  repoCounts: Map<string, number>;
};

export function sortRuns(
  runs: RunRecord[],
  sortKey: SortKey,
  nowMs = Date.now(),
): RunRecord[] {
  return [...runs].sort((a, b) => {
    const aValue = getSortValue(a, sortKey, nowMs);
    const bValue = getSortValue(b, sortKey, nowMs);
    if (aValue !== bValue) {
      return bValue - aValue;
    }
    return a.runId.localeCompare(b.runId);
  });
}

export function groupRunsByRepo(
  runs: RunRecord[],
  sortKey: SortKey,
  nowMs = Date.now(),
): GroupedRuns {
  const repoCounts = new Map<string, number>();
  const groups = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const label = run.repoLabel ?? run.repoId ?? 'current';
    repoCounts.set(label, (repoCounts.get(label) ?? 0) + 1);
    const list = groups.get(label) ?? [];
    list.push(run);
    groups.set(label, list);
  }

  const orderedGroups = Array.from(groups.entries()).sort((a, b) => {
    const aBest = bestGroupValue(a[1], sortKey, nowMs);
    const bBest = bestGroupValue(b[1], sortKey, nowMs);
    if (aBest !== bBest) {
      return bBest - aBest;
    }
    return a[0].localeCompare(b[0]);
  });

  const groupedRuns: RunRecord[] = [];
  for (const [, groupRuns] of orderedGroups) {
    groupedRuns.push(...sortRuns(groupRuns, sortKey, nowMs));
  }

  return { runs: groupedRuns, repoCounts };
}

function bestGroupValue(runs: RunRecord[], sortKey: SortKey, nowMs: number): number {
  return Math.max(...runs.map((run) => getSortValue(run, sortKey, nowMs)), 0);
}

function getSortValue(run: RunRecord, sortKey: SortKey, nowMs: number): number {
  const updatedAt = parseTimestamp(run.latestEventAt ?? run.updatedAt);
  switch (sortKey) {
    case 'started': {
      return parseTimestamp(run.startedAt ?? run.updatedAt);
    }
    case 'duration': {
      const start = parseTimestamp(run.startedAt ?? run.updatedAt);
      const end = run.finishedAt ? parseTimestamp(run.finishedAt) : nowMs;
      return Math.max(0, end - start);
    }
    case 'updated':
    default:
      return updatedAt;
  }
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
