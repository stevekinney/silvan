import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Event } from '../events/schema';
import type { RunStateEnvelope, StateStore } from '../state/store';
import { readStateMetadata } from '../state/store';
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
  listKey?: string;
};

export type RunSnapshotPage = {
  runs: RunSnapshot[];
  total: number;
  nextCursor?: RunSnapshotCursor;
};

export type RunSnapshotCache = {
  snapshots: Map<string, CachedSnapshot>;
  auditSummaries: Map<string, CachedAuditSummary>;
  runFiles?: CachedRunFiles;
  repoLabels: Map<string, string>;
};

type CachedSnapshot = {
  mtimeMs: number;
  snapshot: RunSnapshot;
};

type CachedAuditSummary = {
  mtimeMs: number;
  summary: RunEventSummary;
};

type CachedRunFiles = {
  key: string;
  rootsKey: string;
  files: RunFileEntry[];
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
    repoLabels: new Map(),
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
  const roots = await resolveRunRoots(state, options?.cache);
  const rootsKey = roots
    .map((root) => root.runsDir)
    .sort()
    .join('|');
  let files: RunFileEntry[] = [];
  let listKey = options?.cursor?.listKey;
  const cachedFiles = options?.cache?.runFiles;
  if (
    listKey &&
    cachedFiles &&
    cachedFiles.key === listKey &&
    cachedFiles.rootsKey === rootsKey
  ) {
    files = cachedFiles.files;
  } else {
    files = await listRunFiles(roots);
    files.sort((a, b) => {
      if (a.mtimeMs !== b.mtimeMs) {
        return b.mtimeMs - a.mtimeMs;
      }
      return a.path.localeCompare(b.path);
    });
    listKey = crypto.randomUUID();
    if (options?.cache) {
      options.cache.runFiles = { key: listKey, rootsKey, files };
    }
  }

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
    ...(offset + limit < total
      ? { nextCursor: { offset: offset + limit, ...(listKey ? { listKey } : {}) } }
      : {}),
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

async function resolveRunRoots(
  state: StateStore,
  cache?: RunSnapshotCache,
): Promise<RunRoot[]> {
  const roots: RunRoot[] = [];
  const base = state.root;
  if (basename(base) === '.silvan') {
    const metadataPath = join(base, 'metadata.json');
    const repoLabel = await readRepoLabel(metadataPath, 'current', cache);
    roots.push({
      runsDir: state.runsDir,
      auditDir: state.auditDir,
      repoLabel,
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
    const metadataPath = join(repoRoot, 'metadata.json');
    const repoLabel = await readRepoLabel(metadataPath, repoId, cache);
    roots.push({
      repoId,
      repoLabel,
      runsDir: join(repoRoot, 'runs'),
      auditDir: join(repoRoot, 'audit'),
    });
  }

  return roots;
}

async function readRepoLabel(
  metadataPath: string,
  fallback: string,
  cache?: RunSnapshotCache,
): Promise<string> {
  const cached = cache?.repoLabels.get(metadataPath);
  if (cached) return cached;
  try {
    const metadata = await readStateMetadata(metadataPath);
    const label =
      typeof metadata.repoLabel === 'string' && metadata.repoLabel.length > 0
        ? metadata.repoLabel
        : fallback;
    cache?.repoLabels.set(metadataPath, label);
    return label;
  } catch {
    cache?.repoLabels.set(metadataPath, fallback);
    return fallback;
  }
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

  const eventCount = await countAuditLines(path);
  const latestEventAt = await readLatestEventAt(path);
  const summary: RunEventSummary = {
    eventCount,
    ...(latestEventAt ? { latestEventAt } : {}),
  };
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

async function countAuditLines(path: string): Promise<number> {
  const file = Bun.file(path);
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let count = 0;
  let pending = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = pending + decoder.decode(value, { stream: true });
    const lines = text.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length > 0) {
        count += 1;
      }
    }
  }
  if (pending.trim().length > 0) {
    count += 1;
  }
  return count;
}

async function readLatestEventAt(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  const size = file.size;
  if (!Number.isFinite(size) || size <= 0) return undefined;
  const chunkSize = 64 * 1024;
  let start = Math.max(0, size - chunkSize);
  let buffer = await file.slice(start, size).text();
  while (start > 0 && !buffer.includes('\n')) {
    start = Math.max(0, start - chunkSize);
    buffer = await file.slice(start, size).text();
  }
  const lines = buffer
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i] ?? '') as { ts?: string };
      if (typeof parsed.ts === 'string') {
        return parsed.ts;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function extractUpdatedAt(data: Record<string, unknown>): string | undefined {
  const run = typeof data['run'] === 'object' && data['run'] ? data['run'] : undefined;
  if (!run || typeof run !== 'object') return undefined;
  const updatedAt = (run as { updatedAt?: string }).updatedAt;
  return typeof updatedAt === 'string' ? updatedAt : undefined;
}
