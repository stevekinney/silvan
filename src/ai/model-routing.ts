import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config } from '../config/schema';
import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import type { Event } from '../events/schema';
import type { StateStore } from '../state/store';
import { getCognitionModel } from './cognition/policy';
import type { CognitionTask } from './router';

export type ModelRoutingRecommendation = {
  task: CognitionTask;
  baselineModel: string;
  recommendedModel: string;
  sampleCount: number;
  successRate: number;
  baselineSuccessRate: number;
  avgDurationMs: number;
  baselineDurationMs: number;
  latencyDeltaRatio: number;
  reason: string;
};

export type ModelRoutingStats = {
  task: CognitionTask;
  model: string;
  provider: string;
  sampleCount: number;
  successCount: number;
  successRate: number;
  avgDurationMs: number;
};

export type ModelRoutingReport = {
  generatedAt: string;
  lookbackDays: number;
  totalSessions: number;
  tasksEvaluated: number;
  modelsEvaluated: number;
  stats: ModelRoutingStats[];
  recommendations: ModelRoutingRecommendation[];
  configSnippet: { ai: { cognition: { modelByTask: Record<string, string> } } };
};

export type ModelRoutingDecision = {
  config: Config;
  report: ModelRoutingReport | null;
  applied: boolean;
  appliedModels: Record<string, string>;
};

type ModelRoutingFilters = {
  sinceMs: number | null;
  untilMs: number | null;
};

type ModelStatsAccumulator = {
  provider: string;
  model: string;
  sampleCount: number;
  successCount: number;
  totalDurationMs: number;
};

const DEFAULT_LOOKBACK_DAYS = 30;

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildFilters(config: Config, now: Date): ModelRoutingFilters {
  const lookbackDays = config.ai.cognition.routing.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const untilMs = now.getTime();
  const sinceMs = untilMs - lookbackDays * 24 * 60 * 60 * 1000;
  return { sinceMs, untilMs };
}

function normalizeTask(value: unknown): CognitionTask | null {
  if (typeof value !== 'string') return null;
  if (value === 'execute') return null;
  return value as CognitionTask;
}

function normalizeOk(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return true;
}

function shouldIncludeEvent(event: Event, filters: ModelRoutingFilters): boolean {
  const ts = parseTimestamp(event.ts);
  if (ts === null) return false;
  if (filters.sinceMs !== null && ts < filters.sinceMs) return false;
  if (filters.untilMs !== null && ts > filters.untilMs) return false;
  return true;
}

async function listAuditFiles(auditDir: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(auditDir);
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.endsWith('.jsonl'));
}

async function readAuditLogEvents(path: string): Promise<Event[]> {
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
      events.push(JSON.parse(line) as Event);
    } catch {
      continue;
    }
  }
  return events;
}

function buildStats(
  events: Event[],
  filters: ModelRoutingFilters,
): {
  stats: ModelRoutingStats[];
  totalSessions: number;
} {
  const stats = new Map<string, Map<string, ModelStatsAccumulator>>();
  let totalSessions = 0;

  for (const event of events) {
    if (event.type !== 'ai.session_finished') continue;
    if (!shouldIncludeEvent(event, filters)) continue;
    const payload = event.payload as {
      model?: { provider?: string; model?: string };
      task?: unknown;
      ok?: unknown;
      durationMs?: unknown;
    };
    const task = normalizeTask(payload.task);
    if (!task) continue;
    const model = payload.model?.model;
    const provider = payload.model?.provider ?? 'unknown';
    if (!model) continue;
    const durationMs =
      typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs)
        ? payload.durationMs
        : null;
    if (durationMs === null) continue;

    totalSessions += 1;
    const taskMap = stats.get(task) ?? new Map<string, ModelStatsAccumulator>();
    const entry =
      taskMap.get(model) ??
      ({
        provider,
        model,
        sampleCount: 0,
        successCount: 0,
        totalDurationMs: 0,
      } satisfies ModelStatsAccumulator);
    entry.sampleCount += 1;
    if (normalizeOk(payload.ok)) {
      entry.successCount += 1;
    }
    entry.totalDurationMs += durationMs;
    taskMap.set(model, entry);
    stats.set(task, taskMap);
  }

  const flattened: ModelRoutingStats[] = [];
  for (const [task, models] of stats.entries()) {
    for (const entry of models.values()) {
      const avgDurationMs = entry.sampleCount
        ? entry.totalDurationMs / entry.sampleCount
        : 0;
      const successRate = entry.sampleCount ? entry.successCount / entry.sampleCount : 0;
      flattened.push({
        task: task as CognitionTask,
        model: entry.model,
        provider: entry.provider,
        sampleCount: entry.sampleCount,
        successCount: entry.successCount,
        successRate,
        avgDurationMs,
      });
    }
  }

  return { stats: flattened, totalSessions };
}

function pickBaselineModel(
  config: Config,
  task: CognitionTask,
  stats: ModelRoutingStats[],
): ModelRoutingStats | null {
  const baselineModel = getCognitionModel(config, task);
  const match = stats.find((entry) => entry.model === baselineModel);
  if (match) return match;
  const sorted = [...stats].sort((a, b) => b.sampleCount - a.sampleCount);
  return sorted[0] ?? null;
}

function pickCandidateModel(stats: ModelRoutingStats[]): ModelRoutingStats | null {
  if (stats.length === 0) return null;
  const sorted = [...stats].sort((a, b) => {
    if (b.successRate !== a.successRate) {
      return b.successRate - a.successRate;
    }
    if (a.avgDurationMs !== b.avgDurationMs) {
      return a.avgDurationMs - b.avgDurationMs;
    }
    return b.sampleCount - a.sampleCount;
  });
  return sorted[0] ?? null;
}

function shouldRecommend(options: {
  baseline: ModelRoutingStats;
  candidate: ModelRoutingStats;
  maxLatencyDelta: number;
}): boolean {
  if (options.candidate.model === options.baseline.model) return false;
  if (options.candidate.successRate < options.baseline.successRate) return false;
  const latencyDeltaRatio =
    options.baseline.avgDurationMs === 0
      ? 0
      : (options.candidate.avgDurationMs - options.baseline.avgDurationMs) /
        options.baseline.avgDurationMs;
  return latencyDeltaRatio <= options.maxLatencyDelta;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function buildReason(baseline: ModelRoutingStats, candidate: ModelRoutingStats): string {
  const successDelta = candidate.successRate - baseline.successRate;
  const latencyDeltaRatio =
    baseline.avgDurationMs === 0
      ? 0
      : (candidate.avgDurationMs - baseline.avgDurationMs) / baseline.avgDurationMs;
  const successLabel = formatPercent(Math.abs(successDelta));
  const latencyLabel = formatPercent(Math.abs(latencyDeltaRatio));
  const successDirection = successDelta >= 0 ? 'higher' : 'lower';
  const latencyDirection = latencyDeltaRatio >= 0 ? 'slower' : 'faster';
  return `${successLabel} ${successDirection} success, ${latencyLabel} ${latencyDirection} latency`;
}

export async function buildModelRoutingReport(options: {
  state: StateStore;
  config: Config;
  now?: Date;
}): Promise<ModelRoutingReport> {
  const now = options.now ?? new Date();
  const routing = options.config.ai.cognition.routing;
  const filters = buildFilters(options.config, now);
  const auditFiles = await listAuditFiles(options.state.auditDir);
  const allEvents: Event[] = [];

  for (const entry of auditFiles) {
    const path = join(options.state.auditDir, entry);
    const events = await readAuditLogEvents(path);
    allEvents.push(...events);
  }

  const { stats, totalSessions } = buildStats(allEvents, filters);
  const minSamples = routing.minSamples;
  const byTask = new Map<CognitionTask, ModelRoutingStats[]>();
  for (const entry of stats) {
    if (entry.sampleCount < minSamples) continue;
    const list = byTask.get(entry.task) ?? [];
    list.push(entry);
    byTask.set(entry.task, list);
  }

  const recommendations: ModelRoutingRecommendation[] = [];
  for (const [task, taskStats] of byTask.entries()) {
    const baseline = pickBaselineModel(options.config, task, taskStats);
    const candidate = pickCandidateModel(taskStats);
    if (!baseline || !candidate) continue;
    if (
      !shouldRecommend({
        baseline,
        candidate,
        maxLatencyDelta: routing.maxLatencyDelta,
      })
    ) {
      continue;
    }

    const latencyDeltaRatio =
      baseline.avgDurationMs === 0
        ? 0
        : (candidate.avgDurationMs - baseline.avgDurationMs) / baseline.avgDurationMs;
    recommendations.push({
      task,
      baselineModel: baseline.model,
      recommendedModel: candidate.model,
      sampleCount: candidate.sampleCount,
      successRate: candidate.successRate,
      baselineSuccessRate: baseline.successRate,
      avgDurationMs: candidate.avgDurationMs,
      baselineDurationMs: baseline.avgDurationMs,
      latencyDeltaRatio,
      reason: buildReason(baseline, candidate),
    });
  }

  const configSnippet: { ai: { cognition: { modelByTask: Record<string, string> } } } = {
    ai: { cognition: { modelByTask: {} } },
  };
  for (const recommendation of recommendations) {
    configSnippet.ai.cognition.modelByTask[recommendation.task] =
      recommendation.recommendedModel;
  }

  const tasksEvaluated = new Set(stats.map((entry) => entry.task)).size;
  const modelsEvaluated = new Set(stats.map((entry) => entry.model)).size;

  return {
    generatedAt: now.toISOString(),
    lookbackDays: routing.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
    totalSessions,
    tasksEvaluated,
    modelsEvaluated,
    stats,
    recommendations,
    configSnippet,
  };
}

export async function applyCognitionModelRouting(options: {
  state: StateStore;
  config: Config;
  runId?: string;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<ModelRoutingDecision> {
  const routing = options.config.ai.cognition.routing;
  if (!routing.enabled) {
    return { config: options.config, report: null, applied: false, appliedModels: {} };
  }
  if (!routing.autoApply) {
    return { config: options.config, report: null, applied: false, appliedModels: {} };
  }

  const report = await buildModelRoutingReport({
    state: options.state,
    config: options.config,
  });

  if (report.recommendations.length === 0) {
    return { config: options.config, report, applied: false, appliedModels: {} };
  }

  const appliedModels: Record<string, string> = {};
  for (const recommendation of report.recommendations) {
    const taskKey = recommendation.task as keyof Config['ai']['cognition']['modelByTask'];
    if (routing.respectOverrides && options.config.ai.cognition.modelByTask[taskKey]) {
      continue;
    }
    appliedModels[recommendation.task] = recommendation.recommendedModel;
  }

  if (Object.keys(appliedModels).length === 0) {
    return { config: options.config, report, applied: false, appliedModels };
  }

  const nextConfig: Config = {
    ...options.config,
    ai: {
      ...options.config.ai,
      cognition: {
        ...options.config.ai.cognition,
        modelByTask: {
          ...options.config.ai.cognition.modelByTask,
          ...appliedModels,
        },
      },
    },
  };

  if (options.runId) {
    await options.state.updateRunState(options.runId, (data) => ({
      ...data,
      modelRouting: {
        appliedAt: new Date().toISOString(),
        recommendations: report.recommendations.map((entry) => ({
          task: entry.task,
          baselineModel: entry.baselineModel,
          recommendedModel: entry.recommendedModel,
          reason: entry.reason,
        })),
      },
    }));
  }

  if (options.bus && options.context) {
    await options.bus.emit(
      createEnvelope({
        type: 'run.step',
        source: 'ai',
        level: 'info',
        context: options.context,
        payload: {
          stepId: 'ai.model_routing',
          title: 'Model routing applied',
          status: 'succeeded' as const,
        },
      }),
    );
  }

  return { config: nextConfig, report, applied: true, appliedModels };
}
