import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StateStore } from './store';

export type ReviewerStats = {
  updatedAt: string;
  reviewers: Record<
    string,
    {
      requested: number;
      responded: number;
      avgResponseHours?: number;
      lastResponseAt?: string;
    }
  >;
};

const DEFAULT_STATS: ReviewerStats = {
  updatedAt: new Date(0).toISOString(),
  reviewers: {},
};

export async function readReviewerStats(state: StateStore): Promise<ReviewerStats> {
  const path = statsPath(state);
  try {
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw) as ReviewerStats;
    if (parsed && parsed.reviewers) return parsed;
    return DEFAULT_STATS;
  } catch {
    return DEFAULT_STATS;
  }
}

export async function recordReviewerRequests(options: {
  state: StateStore;
  reviewers: string[];
}): Promise<ReviewerStats> {
  const stats = await readReviewerStats(options.state);
  for (const reviewer of options.reviewers) {
    const existing = stats.reviewers[reviewer] ?? { requested: 0, responded: 0 };
    stats.reviewers[reviewer] = {
      ...existing,
      requested: existing.requested + 1,
    };
  }
  stats.updatedAt = new Date().toISOString();
  await writeReviewerStats(options.state, stats);
  return stats;
}

export async function recordReviewerResponses(options: {
  state: StateStore;
  responses: Array<{ reviewer: string; responseHours: number; respondedAt: string }>;
}): Promise<ReviewerStats> {
  const stats = await readReviewerStats(options.state);
  for (const response of options.responses) {
    const existing = stats.reviewers[response.reviewer] ?? {
      requested: 0,
      responded: 0,
      avgResponseHours: undefined,
    };
    const priorAvg = existing.avgResponseHours ?? 0;
    const nextResponded = existing.responded + 1;
    const avgResponseHours =
      nextResponded > 0
        ? (priorAvg * existing.responded + response.responseHours) / nextResponded
        : response.responseHours;
    stats.reviewers[response.reviewer] = {
      ...existing,
      responded: nextResponded,
      avgResponseHours,
      lastResponseAt: response.respondedAt,
    };
  }
  stats.updatedAt = new Date().toISOString();
  await writeReviewerStats(options.state, stats);
  return stats;
}

async function writeReviewerStats(
  state: StateStore,
  stats: ReviewerStats,
): Promise<void> {
  const path = statsPath(state);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(stats, null, 2), 'utf8');
  await rename(temp, path);
}

function statsPath(state: StateStore): string {
  return join(state.root, 'reviewers.json');
}
