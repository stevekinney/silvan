import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { RunStateEnvelope, StateStore } from '../state/store';

export type RunSnapshot = {
  runId: string;
  repoId?: string;
  repoLabel?: string;
  path: string;
  updatedAt: string;
  data: Record<string, unknown>;
};

const DEFAULT_RUN_LIMIT = 25;

export async function loadRunSnapshots(
  state: StateStore,
  options?: { limit?: number },
): Promise<RunSnapshot[]> {
  const limit = options?.limit ?? DEFAULT_RUN_LIMIT;
  const roots = await resolveRunRoots(state);
  const snapshots: RunSnapshot[] = [];

  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = await readdir(root.runsDir);
    } catch {
      continue;
    }
    const files = entries.filter((entry) => entry.endsWith('.json'));
    for (const file of files) {
      const path = join(root.runsDir, file);
      const runId = file.replace(/\.json$/, '');
      const snapshot = await readRunSnapshot(path, runId, root.repoId, root.repoLabel);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
  }

  snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return snapshots.slice(0, limit);
}

async function resolveRunRoots(
  state: StateStore,
): Promise<Array<{ runsDir: string; repoId?: string; repoLabel?: string }>> {
  const roots: Array<{ runsDir: string; repoId?: string; repoLabel?: string }> = [];
  const base = state.root;
  if (basename(base) === '.silvan') {
    roots.push({ runsDir: state.runsDir, repoLabel: 'current' });
    return roots;
  }

  const repoBase = dirname(base);
  const dataRoot = basename(repoBase) === 'repos' ? dirname(repoBase) : base;
  const globalReposDir = join(dataRoot, 'repos');
  let repoIds: string[] = [];
  try {
    repoIds = await readdir(globalReposDir);
  } catch {
    roots.push({ runsDir: state.runsDir });
    return roots;
  }

  for (const repoId of repoIds) {
    roots.push({
      repoId,
      repoLabel: repoId,
      runsDir: join(globalReposDir, repoId, 'runs'),
    });
  }

  return roots;
}

async function readRunSnapshot(
  path: string,
  runId: string,
  repoId?: string,
  repoLabel?: string,
): Promise<RunSnapshot | null> {
  try {
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw) as RunStateEnvelope;
    const data =
      parsed && typeof parsed === 'object' && 'data' in parsed
        ? (parsed.data as Record<string, unknown>)
        : (parsed as unknown as Record<string, unknown>);
    const fileStat = await stat(path);
    const updatedAt = extractUpdatedAt(data) ?? fileStat.mtime.toISOString();
    return {
      runId,
      ...(repoId ? { repoId } : {}),
      ...(repoLabel ? { repoLabel } : {}),
      path,
      updatedAt,
      data,
    };
  } catch {
    return null;
  }
}

function extractUpdatedAt(data: Record<string, unknown>): string | undefined {
  const run = typeof data['run'] === 'object' && data['run'] ? data['run'] : undefined;
  if (!run || typeof run !== 'object') return undefined;
  const updatedAt = (run as { updatedAt?: string }).updatedAt;
  return typeof updatedAt === 'string' ? updatedAt : undefined;
}
