import type { Config } from '../config/schema';
import type { StateStore } from '../state/store';
import type { Task } from '../task/types';
import { hashString } from '../utils/hash';
import { generatePlan } from './cognition/planner';
import { createConversationStore } from './conversation/store';

export type ModelBenchmarkResult = {
  model: string;
  provider: string;
  ok: boolean;
  durationMs: number;
  summary?: string;
  error?: string;
};

export type ModelBenchmarkReport = {
  generatedAt: string;
  task: Task;
  provider: string;
  results: ModelBenchmarkResult[];
};

const DEFAULT_BENCHMARK_TASK: Task = {
  id: 'benchmark-plan',
  provider: 'local',
  title: 'Benchmark planning quality for this repo',
  description:
    'Create a concise execution plan for adding a small utility module. Focus on steps, files, verification, and risks.',
  acceptanceCriteria: [
    'Plan includes explicit steps and verification.',
    'Plan references likely files to touch.',
  ],
  labels: [],
};

function buildBenchmarkRunId(model: string): string {
  return `benchmark-${hashString(`${model}-${Date.now()}`).slice(0, 8)}`;
}

function buildBenchmarkConfig(config: Config, model: string): Config {
  return {
    ...config,
    ai: {
      ...config.ai,
      cache: { ...config.ai.cache, enabled: false },
      cognition: {
        ...config.ai.cognition,
        routing: {
          ...config.ai.cognition.routing,
          enabled: false,
          autoApply: false,
        },
        modelByTask: {
          ...config.ai.cognition.modelByTask,
          plan: model,
        },
      },
    },
  };
}

export async function benchmarkCognitionModels(options: {
  state: StateStore;
  config: Config;
  repoRoot: string;
  models: string[];
  task?: Task;
}): Promise<ModelBenchmarkReport> {
  const task = options.task ?? DEFAULT_BENCHMARK_TASK;
  const provider = options.config.ai.cognition.provider;
  const results: ModelBenchmarkResult[] = [];

  for (const model of options.models) {
    const runId = buildBenchmarkRunId(model);
    const config = buildBenchmarkConfig(options.config, model);
    const store = createConversationStore({
      runId,
      state: options.state,
      config,
    });
    const start = performance.now();
    try {
      const plan = await generatePlan({
        task,
        repoRoot: options.repoRoot,
        store,
        config,
        worktreeName: 'benchmark',
      });
      const durationMs = Math.round(performance.now() - start);
      results.push({
        model,
        provider,
        ok: true,
        durationMs,
        summary: plan.summary,
      });
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      results.push({
        model,
        provider,
        ok: false,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    task,
    provider,
    results,
  };
}
