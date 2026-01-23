import { readdir } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

import type { CiState } from '../events/schema';
import type { ArtifactEntry } from '../state/artifacts';
import { readArtifact } from '../state/artifacts';
import type { StateStore } from '../state/store';
import type { LearningNotes } from './notes';

const SAFE_LEARNING_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt']);

export type LearningHistoryEntry = {
  runId: string;
  updatedAt?: string;
  notes: LearningNotes;
};

export type LearningConsistencyResult = {
  score: number;
  sampleCount: number;
  matchedItems: number;
  totalItems: number;
};

export type LearningConfidenceBreakdown = {
  consistency: number;
  review: number;
  ci: number;
  sampleCount: number;
  matchedItems: number;
  totalItems: number;
};

export type LearningConfidenceResult = {
  confidence: number;
  threshold: number;
  breakdown: LearningConfidenceBreakdown;
};

export type LearningTargetCheck = {
  ok: boolean;
  reasons: string[];
  resolvedTargets: { rules?: string; skills?: string; docs?: string };
};

export function evaluateLearningTargets(options: {
  targets: { rules?: string; skills?: string; docs?: string };
  worktreeRoot: string;
}): LearningTargetCheck {
  const reasons: string[] = [];
  const resolvedTargets: LearningTargetCheck['resolvedTargets'] = {};

  for (const [key, target] of Object.entries(options.targets)) {
    if (!target) continue;
    const absolute = resolve(options.worktreeRoot, target);
    const ext = extname(absolute).toLowerCase();
    if (ext && !SAFE_LEARNING_EXTENSIONS.has(ext)) {
      reasons.push(`Unsupported learning target extension for ${key}: ${ext}`);
    }
    const rel = relative(options.worktreeRoot, absolute);
    if (rel.startsWith('..')) {
      reasons.push(`Learning target for ${key} is outside repo: ${target}`);
    }
    resolvedTargets[key as keyof LearningTargetCheck['resolvedTargets']] = absolute;
  }

  return { ok: reasons.length === 0, reasons, resolvedTargets };
}

export function buildLearningConsistency(
  notes: LearningNotes,
  history: LearningHistoryEntry[],
  minSamples: number,
): LearningConsistencyResult {
  const items = collectLearningItems(notes);
  if (items.length === 0) {
    return { score: 0, sampleCount: history.length, matchedItems: 0, totalItems: 0 };
  }
  const historySet = new Set<string>();
  for (const entry of history) {
    for (const item of collectLearningItems(entry.notes)) {
      historySet.add(item.toLowerCase());
    }
  }

  const matched = items.filter((item) => historySet.has(item.toLowerCase())).length;
  const rawScore = matched / items.length;
  const sampleCount = history.length;
  const sampleFactor = minSamples > 0 ? Math.min(1, sampleCount / minSamples) : 1;
  return {
    score: rawScore * sampleFactor,
    sampleCount,
    matchedItems: matched,
    totalItems: items.length,
  };
}

export function scoreLearningConfidence(options: {
  notes: LearningNotes;
  history: LearningHistoryEntry[];
  minSamples: number;
  threshold: number;
  ci?: CiState;
  unresolvedReviews?: number;
  aiReviewShipIt?: boolean;
}): LearningConfidenceResult {
  const consistency = buildLearningConsistency(
    options.notes,
    options.history,
    options.minSamples,
  );
  const ciScore = deriveCiScore(options.ci);
  const reviewScore = deriveReviewScore(
    options.unresolvedReviews,
    options.aiReviewShipIt,
  );

  const weights = { consistency: 0.5, ci: 0.25, review: 0.25 };
  const weightTotal = weights.consistency + weights.ci + weights.review;
  const confidence =
    (consistency.score * weights.consistency +
      ciScore * weights.ci +
      reviewScore * weights.review) /
    weightTotal;

  return {
    confidence,
    threshold: options.threshold,
    breakdown: {
      consistency: consistency.score,
      review: reviewScore,
      ci: ciScore,
      sampleCount: consistency.sampleCount,
      matchedItems: consistency.matchedItems,
      totalItems: consistency.totalItems,
    },
  };
}

export async function loadLearningHistory(options: {
  state: StateStore;
  excludeRunId?: string;
  lookbackDays?: number;
  maxEntries?: number;
}): Promise<LearningHistoryEntry[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(options.state.runsDir);
  } catch {
    return [];
  }

  const now = Date.now();
  const maxAgeMs =
    typeof options.lookbackDays === 'number'
      ? options.lookbackDays * 24 * 60 * 60 * 1000
      : undefined;
  const history: LearningHistoryEntry[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const runId = entry.replace(/\.json$/, '');
    if (options.excludeRunId && runId === options.excludeRunId) continue;
    const snapshot = await options.state.readRunState(runId);
    if (!snapshot) continue;
    const data = snapshot.data as Record<string, unknown>;
    const run = (typeof data['run'] === 'object' && data['run'] ? data['run'] : {}) as {
      updatedAt?: string;
      finishedAt?: string;
    };
    const updatedAt = run.finishedAt ?? run.updatedAt;
    if (maxAgeMs && updatedAt) {
      const ts = Date.parse(updatedAt);
      if (!Number.isNaN(ts) && now - ts > maxAgeMs) {
        continue;
      }
    }

    const artifactsIndex =
      (data['artifactsIndex'] as
        | Record<string, Record<string, ArtifactEntry>>
        | undefined) ?? {};
    const notesEntry = artifactsIndex['learning.notes']?.['data'];
    if (!notesEntry || !isArtifactEntry(notesEntry)) continue;
    try {
      const notes = await readArtifact<LearningNotes>({ entry: notesEntry });
      history.push({
        runId,
        notes,
        ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
      });
    } catch {
      continue;
    }
  }

  history.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  if (options.maxEntries && history.length > options.maxEntries) {
    return history.slice(0, options.maxEntries);
  }
  return history;
}

function deriveCiScore(state: CiState | undefined): number {
  switch (state) {
    case 'passing':
      return 1;
    case 'failing':
      return 0;
    case 'pending':
      return 0.5;
    case 'unknown':
    default:
      return 0.5;
  }
}

function deriveReviewScore(
  unresolvedReviews: number | undefined,
  aiReviewShipIt: boolean | undefined,
): number {
  if (typeof unresolvedReviews === 'number' && unresolvedReviews > 0) {
    return 0;
  }
  if (aiReviewShipIt === false) {
    return 0;
  }
  if (
    (typeof unresolvedReviews === 'number' && unresolvedReviews === 0) ||
    aiReviewShipIt === true
  ) {
    return 1;
  }
  return 0.5;
}

function collectLearningItems(notes: LearningNotes): string[] {
  return [...notes.rules, ...notes.skills, ...notes.docs].filter((item) => item);
}

function isArtifactEntry(value: unknown): value is ArtifactEntry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['path'] === 'string' &&
    typeof record['stepId'] === 'string' &&
    typeof record['name'] === 'string' &&
    typeof record['digest'] === 'string' &&
    typeof record['updatedAt'] === 'string' &&
    (record['kind'] === 'json' || record['kind'] === 'text')
  );
}
