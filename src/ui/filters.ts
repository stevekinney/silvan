import type { RunRecord } from './types';

export type RunFilters = {
  query: string;
  status: string[];
  phase: string[];
  convergence: string[];
  provider: string[];
  repo: string[];
  task: string[];
  pr: string[];
};

export type FilterKey = keyof Omit<RunFilters, 'query'>;

export function parseFilterInput(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function hasActiveFilters(filters: RunFilters): boolean {
  return (
    filters.query.trim().length > 0 ||
    filters.status.length > 0 ||
    filters.phase.length > 0 ||
    filters.convergence.length > 0 ||
    filters.provider.length > 0 ||
    filters.repo.length > 0 ||
    filters.task.length > 0 ||
    filters.pr.length > 0
  );
}

export function formatFilterSummary(filters: RunFilters): string {
  const parts: string[] = [];
  if (filters.status.length > 0) parts.push(`status=${filters.status.join(',')}`);
  if (filters.phase.length > 0) parts.push(`phase=${filters.phase.join(',')}`);
  if (filters.convergence.length > 0)
    parts.push(`convergence=${filters.convergence.join(',')}`);
  if (filters.provider.length > 0) parts.push(`provider=${filters.provider.join(',')}`);
  if (filters.repo.length > 0) parts.push(`repo=${filters.repo.join(',')}`);
  if (filters.task.length > 0) parts.push(`task=${filters.task.join(',')}`);
  if (filters.pr.length > 0) parts.push(`pr=${filters.pr.join(',')}`);
  if (filters.query.trim().length > 0) parts.push(`search="${filters.query.trim()}"`);
  return parts.join(' ');
}

export function matchesFilters(run: RunRecord, filters: RunFilters): boolean {
  if (filters.status.length > 0 && !matchesExact(run.status, filters.status)) {
    return false;
  }
  if (filters.phase.length > 0 && !matchesExact(run.phase, filters.phase)) {
    return false;
  }
  const convergenceStatus = run.convergence?.status ?? 'unknown';
  if (
    filters.convergence.length > 0 &&
    !matchesExact(convergenceStatus, filters.convergence)
  ) {
    return false;
  }
  if (filters.provider.length > 0) {
    const provider = run.taskProvider ?? 'unknown';
    if (!matchesExact(provider, filters.provider)) {
      return false;
    }
  }
  if (filters.repo.length > 0) {
    const repo = run.repoLabel ?? run.repoId ?? 'current';
    if (!matchesContains(repo, filters.repo)) {
      return false;
    }
  }
  if (filters.task.length > 0) {
    const task = [run.taskKey, run.taskTitle].filter(Boolean).join(' ');
    if (!matchesContains(task, filters.task)) {
      return false;
    }
  }
  if (filters.pr.length > 0) {
    const pr = run.pr?.id ?? '';
    if (!matchesContains(pr, filters.pr)) {
      return false;
    }
  }
  if (filters.query.trim().length > 0 && !matchesQuery(run, filters.query)) {
    return false;
  }
  return true;
}

function matchesExact(value: string, filters: string[]): boolean {
  const normalized = value.trim().toLowerCase();
  return filters.some((filter) => filter.trim().toLowerCase() === normalized);
}

function matchesContains(value: string, filters: string[]): boolean {
  const normalized = value.trim().toLowerCase();
  return filters.some((filter) => normalized.includes(filter.trim().toLowerCase()));
}

function matchesQuery(run: RunRecord, query: string): boolean {
  const haystack = [
    run.runId,
    run.taskId,
    run.taskKey,
    run.taskTitle,
    run.pr?.id,
    run.repoLabel,
    run.repoId,
    run.taskProvider,
    run.phase,
    run.status,
    run.convergence?.status,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.trim().toLowerCase());
}
