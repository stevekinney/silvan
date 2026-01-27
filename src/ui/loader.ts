import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import type { Config } from '../config/schema';
import type { Event } from '../events/schema';
import { listWorktrees } from '../git/worktree';
import { sortByPriority } from '../queue/priority';
import { buildQueueRequestView } from '../queue/view';
import { listQueueRequestsInDir } from '../state/queue';
import type { RunStateEnvelope, StateStore } from '../state/store';
import { readStateMetadata } from '../state/store';
import type { QueueRecord, RunEventSummary, WorktreeRecord } from './types';

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

export type DashboardScope = 'all' | 'current';

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

type RepoRoot = {
  repoId?: string;
  repoLabel?: string;
  stateRoot: string;
  runsDir: string;
  auditDir: string;
  queueDir: string;
  repoRoot?: string;
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
    scope?: DashboardScope;
  },
): Promise<RunSnapshotPage> {
  const limit = options?.limit ?? DEFAULT_RUN_LIMIT;
  const offset = options?.cursor?.offset ?? 0;
  const roots = await resolveRunRoots(state, options?.cache, options?.scope);
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

export async function loadQueueRequests(
  state: StateStore,
  config: Config,
  options?: { cache?: RunSnapshotCache; scope?: DashboardScope },
): Promise<QueueRecord[]> {
  const roots = await resolveRepoRoots(state, {
    ...(options?.cache ? { cache: options.cache } : {}),
    ...(options?.scope ? { scope: options.scope } : {}),
  });
  const requests: QueueRecord[] = [];
  const nowMs = Date.now();
  for (const root of roots) {
    const entries = await listQueueRequestsInDir(root.queueDir);
    for (const request of entries) {
      const view = buildQueueRequestView(request, config, nowMs);
      requests.push({
        ...view,
        ...(root.repoId ? { repoId: root.repoId } : {}),
        ...(root.repoLabel ? { repoLabel: root.repoLabel } : {}),
      });
    }
  }
  return requests.sort((a, b) => {
    const repoA = a.repoLabel ?? a.repoId ?? '';
    const repoB = b.repoLabel ?? b.repoId ?? '';
    if (repoA !== repoB) return repoA.localeCompare(repoB);
    return sortByPriority(a, b);
  });
}

export async function loadWorktrees(
  state: StateStore,
  options?: { cache?: RunSnapshotCache; scope?: DashboardScope; includeStatus?: boolean },
): Promise<WorktreeRecord[]> {
  const roots = await resolveRepoRoots(state, {
    ...(options?.cache ? { cache: options.cache } : {}),
    ...(options?.scope ? { scope: options.scope } : {}),
  });
  const worktrees: WorktreeRecord[] = [];
  for (const root of roots) {
    if (!root.repoRoot) continue;
    try {
      await stat(join(root.repoRoot, '.git'));
    } catch {
      continue;
    }
    const repoRootResolved = await realpath(root.repoRoot).catch(() => root.repoRoot);
    let entries = [];
    try {
      entries = await listWorktrees({
        repoRoot: root.repoRoot,
        includeStatus: options?.includeStatus ?? true,
        context: { runId: 'ui', repoRoot: root.repoRoot },
      });
    } catch {
      continue;
    }

    for (const worktree of entries) {
      const worktreeResolved = await realpath(worktree.path).catch(() => worktree.path);
      if (repoRootResolved && worktreeResolved === repoRootResolved) continue;
      const lastActivityAt = await readWorktreeActivityAt(worktree.path);
      const candidatePath = repoRootResolved
        ? relative(repoRootResolved, worktreeResolved)
        : undefined;
      const relativePath =
        candidatePath && !candidatePath.startsWith('..') && !isAbsolute(candidatePath)
          ? candidatePath
          : undefined;
      worktrees.push({
        id: worktree.id,
        path: worktree.path,
        ...(relativePath ? { relativePath } : {}),
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        ...(worktree.headSha ? { headSha: worktree.headSha } : {}),
        ...(worktree.isBare !== undefined ? { isBare: worktree.isBare } : {}),
        ...(worktree.isLocked !== undefined ? { isLocked: worktree.isLocked } : {}),
        ...(worktree.isDirty !== undefined ? { isDirty: worktree.isDirty } : {}),
        ...(root.repoId ? { repoId: root.repoId } : {}),
        ...(root.repoLabel ? { repoLabel: root.repoLabel } : {}),
        ...(lastActivityAt ? { lastActivityAt } : {}),
      });
    }
  }

  return worktrees;
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

async function resolveRepoRoots(
  state: StateStore,
  options?: { cache?: RunSnapshotCache; scope?: DashboardScope },
): Promise<RepoRoot[]> {
  const cache = options?.cache;
  const scope = options?.scope ?? 'all';
  const roots: RepoRoot[] = [];
  const base = state.root;
  if (basename(base) === '.silvan') {
    const metadataPath = join(base, 'metadata.json');
    const repoRootFallback = dirname(base);
    const metadata = await readRepoMetadata(
      metadataPath,
      basename(repoRootFallback) || 'current',
      cache,
    );
    roots.push({
      stateRoot: base,
      runsDir: state.runsDir,
      auditDir: state.auditDir,
      queueDir: state.queueDir,
      repoLabel: metadata.label,
      ...(metadata.repoRoot
        ? { repoRoot: metadata.repoRoot }
        : { repoRoot: repoRootFallback }),
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
    const metadataPath = join(base, 'metadata.json');
    const metadata = await readRepoMetadata(metadataPath, 'current', cache);
    roots.push({
      stateRoot: base,
      runsDir: state.runsDir,
      auditDir: state.auditDir,
      queueDir: state.queueDir,
      repoLabel: metadata.label,
      ...(metadata.repoRoot ? { repoRoot: metadata.repoRoot } : {}),
    });
    return roots;
  }

  const scopedIds =
    scope === 'current' ? repoIds.filter((repoId) => repoId === state.repoId) : repoIds;
  const effectiveIds = scopedIds.length > 0 ? scopedIds : repoIds;

  for (const repoId of effectiveIds) {
    const repoRoot = join(globalReposDir, repoId);
    const metadataPath = join(repoRoot, 'metadata.json');
    const metadata = await readRepoMetadata(metadataPath, repoId, cache);
    roots.push({
      repoId,
      repoLabel: metadata.label,
      stateRoot: repoRoot,
      runsDir: join(repoRoot, 'runs'),
      auditDir: join(repoRoot, 'audit'),
      queueDir: join(repoRoot, 'queue', 'requests'),
      ...(metadata.repoRoot ? { repoRoot: metadata.repoRoot } : {}),
    });
  }

  return roots;
}

async function resolveRunRoots(
  state: StateStore,
  cache?: RunSnapshotCache,
  scope?: DashboardScope,
): Promise<RunRoot[]> {
  const roots = await resolveRepoRoots(state, {
    ...(cache ? { cache } : {}),
    ...(scope ? { scope } : {}),
  });
  return roots.map((root) => ({
    runsDir: root.runsDir,
    auditDir: root.auditDir,
    ...(root.repoId ? { repoId: root.repoId } : {}),
    ...(root.repoLabel ? { repoLabel: root.repoLabel } : {}),
  }));
}

async function readRepoMetadata(
  metadataPath: string,
  fallback: string,
  cache?: RunSnapshotCache,
): Promise<{ label: string; repoRoot?: string }> {
  try {
    const metadata = await readStateMetadata(metadataPath);
    const label =
      typeof metadata.repoLabel === 'string' && metadata.repoLabel.length > 0
        ? metadata.repoLabel
        : fallback;
    cache?.repoLabels.set(metadataPath, label);
    const repoRoot =
      typeof metadata.repoRoot === 'string' && metadata.repoRoot.length > 0
        ? metadata.repoRoot
        : undefined;
    return { label, ...(repoRoot ? { repoRoot } : {}) };
  } catch {
    cache?.repoLabels.set(metadataPath, fallback);
    return { label: fallback };
  }
}

async function readWorktreeActivityAt(worktreePath: string): Promise<string | undefined> {
  const gitDir = await resolveWorktreeGitDir(worktreePath);
  const candidates = gitDir
    ? [join(gitDir, 'logs', 'HEAD'), join(gitDir, 'index'), join(gitDir, 'HEAD')]
    : [];
  let latestMs: number | undefined;
  for (const candidate of candidates) {
    try {
      const stats = await stat(candidate);
      latestMs = Math.max(latestMs ?? 0, stats.mtimeMs);
    } catch {
      // ignore missing files
    }
  }
  if (!latestMs) {
    try {
      const stats = await stat(worktreePath);
      latestMs = stats.mtimeMs;
    } catch {
      return undefined;
    }
  }
  return new Date(latestMs).toISOString();
}

async function resolveWorktreeGitDir(worktreePath: string): Promise<string | null> {
  const gitPath = join(worktreePath, '.git');
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(gitPath);
  } catch {
    return null;
  }
  if (stats.isDirectory()) {
    return gitPath;
  }
  if (!stats.isFile()) {
    return null;
  }
  try {
    const raw = await Bun.file(gitPath).text();
    const match = raw.match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;
    const value = match[1]?.trim();
    if (!value) return null;
    return isAbsolute(value) ? value : join(worktreePath, value);
  } catch {
    return null;
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
