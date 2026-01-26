import { readdir } from 'node:fs/promises';

import { loadConfig } from '../../config/load';
import type { ConfigInput } from '../../config/schema';
import { SilvanError } from '../../core/errors';
import { detectRepoContext } from '../../core/repo';
import { deriveConvergenceFromSnapshot, loadRunSnapshot } from '../../run/controls';
import { initStateStore } from '../../state/store';
import {
  deriveRunListStatus,
  type RunListEntry,
  type RunListRenderOptions,
} from '../run-list-output';
import type { CliOptions } from '../types';

export type RunListFilters = {
  status?: string[];
  phase?: string[];
  source?: string[];
};

export type RunListPaging = {
  total: number;
  filteredTotal: number;
  limit: number;
  offset: number;
  paged: RunListEntry[];
};

export type RunListFormat = 'table' | 'minimal' | 'json';

type RunListPagingOptions = {
  limit?: string;
  offset?: string;
};

export type RunListDeps = {
  buildConfigOverrides: (options: CliOptions) => ConfigInput;
  parseNumberFlag: (value: string | undefined) => number | null;
};

export async function loadRunListContext(
  options: CliOptions,
  deps: RunListDeps,
): Promise<{ repoRoot: string; state: Awaited<ReturnType<typeof initStateStore>> }> {
  const configResult = await loadConfig(deps.buildConfigOverrides(options), {
    cwd: process.cwd(),
  });
  const repo = await detectRepoContext({ cwd: configResult.projectRoot });
  const state = await initStateStore(repo.projectRoot, {
    lock: false,
    mode: configResult.config.state.mode,
    ...(configResult.config.state.root ? { root: configResult.config.state.root } : {}),
    metadataRepoRoot: repo.gitRoot,
  });
  return { repoRoot: repo.projectRoot, state };
}

export async function collectRunListEntries(
  state: Awaited<ReturnType<typeof initStateStore>>,
): Promise<RunListEntry[]> {
  const runEntries = await readdir(state.runsDir);
  const files = runEntries.filter((entry) => entry.endsWith('.json'));
  const runs: RunListEntry[] = [];

  for (const file of files) {
    const runId = file.replace(/\.json$/, '');
    const snapshot = await state.readRunState(runId);
    if (!snapshot) continue;
    const entry = buildRunListEntry(runId, snapshot);
    if (entry) {
      runs.push(entry);
    }
  }

  return runs.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export function applyRunListFilters(
  runs: RunListEntry[],
  filters: RunListFilters,
): RunListEntry[] {
  let filtered = runs;
  if (filters.status?.length) {
    filtered = filtered.filter((run) => filters.status?.includes(run.status));
  }
  if (filters.phase?.length) {
    filtered = filtered.filter((run) =>
      filters.phase?.includes((run.phase ?? 'unknown').toLowerCase()),
    );
  }
  if (filters.source?.length) {
    filtered = filtered.filter((run) =>
      filters.source?.includes((run.taskProvider ?? 'unknown').toLowerCase()),
    );
  }
  return filtered;
}

export function resolveRunListPaging(
  filtered: RunListEntry[],
  total: number,
  options: RunListPagingOptions,
  deps: RunListDeps,
): RunListPaging {
  const filteredTotal = filtered.length;
  const limit = Math.max(1, deps.parseNumberFlag(options.limit) ?? 20);
  const offset = Math.max(0, deps.parseNumberFlag(options.offset) ?? 0);
  return {
    total,
    filteredTotal,
    limit,
    offset,
    paged: filtered.slice(offset, offset + limit),
  };
}

export function resolveRunListFormat(
  format: string | undefined,
  jsonFlag: boolean | undefined,
): RunListFormat {
  const normalized = (format ?? 'table').toLowerCase();
  const useJson = Boolean(jsonFlag) || normalized === 'json';
  if (!['table', 'minimal', 'json'].includes(normalized)) {
    throw new SilvanError({
      code: 'run.list.invalid_format',
      message: `Unknown format: ${normalized}`,
      userMessage: `Unknown format: ${normalized}`,
      kind: 'validation',
      nextSteps: ['Use --format table, minimal, or json.'],
    });
  }
  return useJson ? 'json' : (normalized as RunListFormat);
}

export function buildRunListJson(paging: RunListPaging) {
  return {
    total: paging.total,
    filtered: paging.filteredTotal,
    showing: paging.paged.length,
    runs: paging.paged.map((run) => ({
      id: run.runId,
      status: run.status,
      phase: run.phase,
      task: {
        title: run.taskTitle ?? 'Untitled',
        source: run.taskProvider ?? null,
        key: run.taskKey ?? null,
      },
      updatedAt: run.updatedAt ?? null,
      startedAt: run.startedAt ?? null,
      ...(run.prUrl ? { pr: { url: run.prUrl } } : {}),
      ...(run.convergence
        ? {
            convergence: {
              status: run.convergence.status,
              reason: run.convergence.reason,
            },
          }
        : {}),
    })),
  };
}

export function buildRunListNextSteps(runs: RunListEntry[]): string[] {
  const firstRun = runs[0];
  if (!firstRun) {
    return ['silvan task start "Your task"'];
  }
  return [`silvan run inspect ${firstRun.runId}`, `silvan run status ${firstRun.runId}`];
}

export function buildRunListRenderOptions(
  filters: RunListFilters,
  paging: RunListPaging,
  showSource: boolean,
): RunListRenderOptions {
  return {
    total: paging.total,
    filteredTotal: paging.filteredTotal,
    showing: paging.paged.length,
    limit: paging.limit,
    offset: paging.offset,
    showSource,
    filters: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.phase ? { phase: filters.phase } : {}),
      ...(filters.source ? { source: filters.source } : {}),
    },
  };
}

function buildRunListEntry(
  runId: string,
  snapshot: Awaited<ReturnType<typeof loadRunSnapshot>>,
): RunListEntry | null {
  const data = snapshot.data as Record<string, unknown>;
  const run = (typeof data['run'] === 'object' && data['run'] ? data['run'] : {}) as {
    status?: string;
    phase?: string;
    step?: string;
    updatedAt?: string;
    startedAt?: string;
  };
  const summary = (
    typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}
  ) as { prUrl?: string };
  const task = (typeof data['task'] === 'object' && data['task'] ? data['task'] : {}) as {
    title?: string;
    key?: string;
    provider?: string;
  };
  const taskRef = (
    typeof data['taskRef'] === 'object' && data['taskRef'] ? data['taskRef'] : {}
  ) as { id?: string; raw?: string; provider?: string };
  const convergence = deriveConvergenceFromSnapshot(snapshot);

  const taskTitle = task.title ?? taskRef.raw;
  const taskKey = task.key ?? taskRef.id;
  const taskProvider = task.provider ?? taskRef.provider;

  return {
    runId,
    status: deriveRunListStatus(run.status, convergence.status),
    phase: run.phase ?? 'unknown',
    ...(typeof taskTitle === 'string' ? { taskTitle } : {}),
    ...(typeof taskKey === 'string' ? { taskKey } : {}),
    ...(typeof taskProvider === 'string' ? { taskProvider } : {}),
    ...(typeof run.updatedAt === 'string' ? { updatedAt: run.updatedAt } : {}),
    ...(typeof run.startedAt === 'string' ? { startedAt: run.startedAt } : {}),
    ...(typeof summary.prUrl === 'string' ? { prUrl: summary.prUrl } : {}),
    convergence: { status: convergence.status, reason: convergence.message },
  };
}
