import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Event } from '../events/schema';
import type { RunStateEnvelope, StateStore } from '../state/store';
import type { RunEventSummary } from './types';

export type RunSnapshot = {
  runId: string;
  repoId?: string;
  repoLabel?: string;
  path: string;
  updatedAt: string;
  data: Record<string, unknown>;
  eventSummary?: RunEventSummary;
};

export type RunSnapshotCursor = {
  offset: number;
};

export type RunSnapshotPage = {
  runs: RunSnapshot[];
  total: number;
  nextCursor?: RunSnapshotCursor;
};

export type RunSnapshotCache = {
  snapshots: Map<string, CachedSnapshot>;
  auditSummaries: Map<string, CachedAuditSummary>;
};

type CachedSnapshot = {
  mtimeMs: number;
  snapshot: RunSnapshot;
};

type CachedAuditSummary = {
  mtimeMs: number;
  summary: RunEventSummary;
};

type RunRoot = {
  runsDir: string;
  auditDir: string;
  repoId?: string;
  repoLabel?: string;
};

type RunFileEntry = {
  runId: string;
  path: string;
  auditPath: string;
  mtimeMs: number;
  repoId?: string;
  repoLabel?: string;
};

const DEFAULT_RUN_LIMIT = 25;

export function createRunSnapshotCache(): RunSnapshotCache {
  return {
    snapshots: new Map(),
    auditSummaries: new Map(),
  };
}

export async function loadRunSnapshots(
  state: StateStore,
  options?: {
    limit?: number;
    cursor?: RunSnapshotCursor;
    cache?: RunSnapshotCache;
    includeAudit?: boolean;
  },
): Promise<RunSnapshotPage> {
  const limit = options?.limit ?? DEFAULT_RUN_LIMIT;
  const offset = options?.cursor?.offset ?? 0;
  const roots = await resolveRunRoots(state);
  const files = await listRunFiles(roots);
  files.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    return a.path.localeCompare(b.path);
  });

  const total = files.length;
  const page = files.slice(offset, offset + limit);
  const runs: RunSnapshot[] = [];

  for (const file of page) {
    const snapshot = await readRunSnapshotWithCache(file, options?.cache);
    if (!snapshot) continue;
    const eventSummary =
      options?.includeAudit === false
        ? undefined
        : await readAuditSummary(file.auditPath, options?.cache);
    runs.push({
      ...snapshot,
      ...(eventSummary ? { eventSummary } : {}),
    });
  }

  return {
    runs,
    total,
    ...(offset + limit < total ? { nextCursor: { offset: offset + limit } } : {}),
  };
}

export async function loadRunEvents(options: {
  state: StateStore;
  runId: string;
  repoId?: string;
  limit?: number;
  since?: string;
}): Promise<Event[]> {
  const auditPath = await findAuditLogPath(options.state, options.runId, options.repoId);
  if (!auditPath) return [];
  return readAuditLogEvents(auditPath, {
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.since ? { since: options.since } : {}),
  });
}

async function listRunFiles(roots: RunRoot[]): Promise<RunFileEntry[]> {
  const entries: RunFileEntry[] = [];
  for (const root of roots) {
    let files: string[] = [];
    try {
      files = await readdir(root.runsDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const runId = file.replace(/\.json$/, '');
      const path = join(root.runsDir, file);
      let fileStat: Awaited<ReturnType<typeof stat>> | undefined;
      try {
        fileStat = await stat(path);
      } catch {
        continue;
      }
      entries.push({
        runId,
        path,
        auditPath: join(root.auditDir, `${runId}.jsonl`),
        mtimeMs: fileStat.mtimeMs,
        ...(root.repoId ? { repoId: root.repoId } : {}),
        ...(root.repoLabel ? { repoLabel: root.repoLabel } : {}),
      });
    }
  }
  return entries;
}

async function resolveRunRoots(state: StateStore): Promise<RunRoot[]> {
  const roots: RunRoot[] = [];
  const base = state.root;
  if (basename(base) === '.silvan') {
    roots.push({
      runsDir: state.runsDir,
      auditDir: state.auditDir,
      repoLabel: 'current',
    });
    return roots;
  }

  const repoBase = dirname(base);
  const dataRoot = basename(repoBase) === 'repos' ? dirname(repoBase) : base;
  const globalReposDir = join(dataRoot, 'repos');
  let repoIds: string[] = [];
  try {
    repoIds = await readdir(globalReposDir);
  } catch {
    roots.push({ runsDir: state.runsDir, auditDir: state.auditDir });
    return roots;
  }

  for (const repoId of repoIds) {
    const repoRoot = join(globalReposDir, repoId);
    roots.push({
      repoId,
      repoLabel: repoId,
      runsDir: join(repoRoot, 'runs'),
      auditDir: join(repoRoot, 'audit'),
    });
  }

  return roots;
}

async function readRunSnapshotWithCache(
  file: RunFileEntry,
  cache?: RunSnapshotCache,
): Promise<RunSnapshot | null> {
  const cached = cache?.snapshots.get(file.path);
  if (cached && cached.mtimeMs === file.mtimeMs) {
    return { ...cached.snapshot };
  }
  const snapshot = await readRunSnapshot(
    file.path,
    file.runId,
    file.repoId,
    file.repoLabel,
    file.mtimeMs,
  );
  if (snapshot && cache) {
    cache.snapshots.set(file.path, { mtimeMs: file.mtimeMs, snapshot });
  }
  return snapshot ? { ...snapshot } : null;
}

async function readRunSnapshot(
  path: string,
  runId: string,
  repoId?: string,
  repoLabel?: string,
  mtimeMs?: number,
): Promise<RunSnapshot | null> {
  try {
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw) as RunStateEnvelope;
    const data =
      parsed && typeof parsed === 'object' && 'data' in parsed
        ? (parsed.data as Record<string, unknown>)
        : (parsed as unknown as Record<string, unknown>);
    let updatedAt = extractUpdatedAt(data);
    if (!updatedAt) {
      if (typeof mtimeMs === 'number') {
        updatedAt = new Date(mtimeMs).toISOString();
      } else {
        const fileStat = await stat(path);
        updatedAt = fileStat.mtime.toISOString();
      }
    }
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

async function readAuditSummary(
  path: string,
  cache?: RunSnapshotCache,
): Promise<RunEventSummary> {
  let fileStat: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    fileStat = await stat(path);
  } catch {
    return { eventCount: 0 };
  }

  const cached = cache?.auditSummaries.get(path);
  if (cached && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.summary;
  }

  let raw = '';
  try {
    raw = await Bun.file(path).text();
  } catch {
    return { eventCount: 0 };
  }

  const summary = buildEventSummary(raw);
  cache?.auditSummaries.set(path, { mtimeMs: fileStat.mtimeMs, summary });
  return summary;
}

async function findAuditLogPath(
  state: StateStore,
  runId: string,
  repoId?: string,
): Promise<string | null> {
  const roots = await resolveRunRoots(state);
  const ordered = repoId
    ? [
        ...roots.filter((root) => root.repoId === repoId),
        ...roots.filter((root) => root.repoId !== repoId),
      ]
    : roots;
  for (const root of ordered) {
    const candidate = join(root.auditDir, `${runId}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function readAuditLogEvents(
  path: string,
  options?: { limit?: number; since?: string },
): Promise<Event[]> {
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
      const event = JSON.parse(line) as Event;
      if (options?.since && event.ts < options.since) {
        continue;
      }
      events.push(event);
    } catch {
      // skip malformed entries
    }
  }

  if (options?.limit && events.length > options.limit) {
    return events.slice(-options.limit);
  }
  return events;
}

function buildEventSummary(raw: string): RunEventSummary {
  const trimmed = raw.trim();
  if (!trimmed) return { eventCount: 0 };
  const lines = trimmed.split('\n');
  const lastLine = lines[lines.length - 1];
  let latestEventAt: string | undefined;
  if (lastLine) {
    try {
      const parsed = JSON.parse(lastLine) as { ts?: string };
      if (typeof parsed.ts === 'string') {
        latestEventAt = parsed.ts;
      }
    } catch {
      latestEventAt = undefined;
    }
  }
  return {
    eventCount: lines.length,
    ...(latestEventAt ? { latestEventAt } : {}),
  };
}

function extractUpdatedAt(data: Record<string, unknown>): string | undefined {
  const run = typeof data['run'] === 'object' && data['run'] ? data['run'] : undefined;
  if (!run || typeof run !== 'object') return undefined;
  const updatedAt = (run as { updatedAt?: string }).updatedAt;
  return typeof updatedAt === 'string' ? updatedAt : undefined;
}
