import type { Config } from '../config/schema';
import type { QueueRequest } from '../state/queue';

export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 10;

export type QueuePriorityTier = 'high' | 'medium' | 'low';

export type QueuePriorityInfo = {
  basePriority: number;
  effectivePriority: number;
  boost: number;
  ageMinutes: number;
  tier: QueuePriorityTier;
};

export type QueuePrioritySnapshot = QueuePriorityInfo & {
  priority: number;
  priorityTier: QueuePriorityTier;
  priorityBoost: number;
};

export function normalizeQueuePriority(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return clampQueuePriority(fallback);
  }
  return clampQueuePriority(Math.round(value));
}

export function resolveQueuePriorityInfo(
  request: QueueRequest,
  config: Config,
  nowMs = Date.now(),
): QueuePriorityInfo {
  const basePriority = normalizeQueuePriority(
    request.priority,
    config.queue.priority.default,
  );
  const { boost, ageMinutes } = computePriorityBoost(request.createdAt, config, nowMs);
  const maxPriority = Math.min(
    PRIORITY_MAX,
    normalizeQueuePriority(config.queue.priority.escalation.max, PRIORITY_MAX),
  );
  const effectivePriority = clampQueuePriority(basePriority + boost, maxPriority);
  return {
    basePriority,
    effectivePriority,
    boost,
    ageMinutes,
    tier: resolvePriorityTier(effectivePriority, config),
  };
}

export function applyQueuePriority<T extends QueueRequest>(
  request: T,
  config: Config,
  nowMs = Date.now(),
): T & QueuePrioritySnapshot {
  const info = resolveQueuePriorityInfo(request, config, nowMs);
  return {
    ...request,
    basePriority: info.basePriority,
    priority: info.basePriority,
    priorityTier: info.tier,
    priorityBoost: info.boost,
    boost: info.boost,
    effectivePriority: info.effectivePriority,
    ageMinutes: info.ageMinutes,
    tier: info.tier,
  };
}

export function resolvePriorityTier(priority: number, config: Config): QueuePriorityTier {
  const highMin = config.queue.priority.tiers.highMin;
  const mediumMin = config.queue.priority.tiers.mediumMin;
  if (priority >= highMin) return 'high';
  if (priority >= mediumMin) return 'medium';
  return 'low';
}

export function sortByPriority<
  T extends { effectivePriority: number; createdAt: string },
>(a: T, b: T): number {
  if (a.effectivePriority !== b.effectivePriority) {
    return b.effectivePriority - a.effectivePriority;
  }
  return a.createdAt.localeCompare(b.createdAt);
}

function computePriorityBoost(
  createdAt: string | undefined,
  config: Config,
  nowMs: number,
): { boost: number; ageMinutes: number } {
  const createdAtMs = parseTimestamp(createdAt);
  if (!createdAtMs) {
    return { boost: 0, ageMinutes: 0 };
  }
  const ageMinutes = Math.max(0, (nowMs - createdAtMs) / 60000);
  const { afterMinutes, stepMinutes, boost } = config.queue.priority.escalation;
  if (ageMinutes < afterMinutes) {
    return { boost: 0, ageMinutes };
  }
  const steps = Math.floor((ageMinutes - afterMinutes) / stepMinutes) + 1;
  return { boost: Math.max(0, steps) * boost, ageMinutes };
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function clampQueuePriority(value: number, max = PRIORITY_MAX): number {
  const upper = Math.min(PRIORITY_MAX, max);
  return Math.min(upper, Math.max(PRIORITY_MIN, value));
}
