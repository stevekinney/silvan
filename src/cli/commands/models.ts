import type { CAC } from 'cac';

import { benchmarkCognitionModels } from '../../ai/model-benchmark';
import { buildModelRoutingReport } from '../../ai/model-routing';
import { loadConfig } from '../../config/load';
import type { Config, ConfigInput } from '../../config/schema';
import { SilvanError } from '../../core/errors';
import { detectRepoContext } from '../../core/repo';
import { initStateStore } from '../../state/store';
import { emitJsonSuccess } from '../json-output';
import {
  renderModelBenchmarkReport,
  renderModelRoutingReport,
} from '../model-routing-output';
import type { CliOptions } from '../types';

export type ModelCommandDeps = {
  buildConfigOverrides: (options: CliOptions) => ConfigInput;
  parseNumberFlag: (value: string | undefined) => number | null;
  parseModelList: (value: string | undefined) => string[] | null;
  collectBenchmarkModels: (config: Config) => string[];
};

export function registerModelCommands(cli: CAC, deps: ModelCommandDeps): void {
  cli
    .command('models recommend', 'Recommend cognition models based on recent runs')
    .option('--min-samples <n>', 'Minimum samples per model before recommending')
    .option('--lookback-days <n>', 'Lookback window in days')
    .action(
      async (options: CliOptions & { minSamples?: string; lookbackDays?: string }) => {
        const configResult = await loadConfig(deps.buildConfigOverrides(options), {
          cwd: process.cwd(),
        });
        const repo = await detectRepoContext({ cwd: configResult.projectRoot });
        const state = await initStateStore(repo.projectRoot, {
          lock: false,
          mode: configResult.config.state.mode,
          ...(configResult.config.state.root
            ? { root: configResult.config.state.root }
            : {}),
          metadataRepoRoot: repo.gitRoot,
        });

        const minSamples = deps.parseNumberFlag(options.minSamples);
        const lookbackDays = deps.parseNumberFlag(options.lookbackDays);
        const config: Config = {
          ...configResult.config,
          ai: {
            ...configResult.config.ai,
            cognition: {
              ...configResult.config.ai.cognition,
              routing: {
                ...configResult.config.ai.cognition.routing,
                ...(minSamples ? { minSamples } : {}),
                ...(lookbackDays ? { lookbackDays } : {}),
              },
            },
          },
        };

        const report = await buildModelRoutingReport({ state, config });
        const nextSteps = ['silvan models benchmark --models <model-a,model-b>'];

        if (options.json) {
          await emitJsonSuccess({
            command: 'models recommend',
            data: report,
            nextSteps,
            repoRoot: repo.projectRoot,
          });
          return;
        }

        if (options.quiet) {
          return;
        }

        console.log(
          renderModelRoutingReport({
            report,
            autoApply: config.ai.cognition.routing.autoApply,
            minSamples: config.ai.cognition.routing.minSamples,
          }),
        );
      },
    );

  cli
    .command('models benchmark', 'Benchmark cognition models with a sample plan')
    .option('--models <models>', 'Comma-separated list of models to compare')
    .action(async (options: CliOptions & { models?: string }) => {
      const configResult = await loadConfig(deps.buildConfigOverrides(options), {
        cwd: process.cwd(),
      });
      const repo = await detectRepoContext({ cwd: configResult.projectRoot });
      const state = await initStateStore(repo.projectRoot, {
        lock: false,
        mode: configResult.config.state.mode,
        ...(configResult.config.state.root
          ? { root: configResult.config.state.root }
          : {}),
        metadataRepoRoot: repo.gitRoot,
      });

      const explicitModels = deps.parseModelList(options.models);
      const models = explicitModels ?? deps.collectBenchmarkModels(configResult.config);
      const uniqueModels = Array.from(new Set(models));
      if (uniqueModels.length < 2) {
        throw new SilvanError({
          code: 'models.benchmark.insufficient_models',
          message: 'Provide at least two models to benchmark.',
          userMessage: 'Provide at least two models to benchmark.',
          kind: 'validation',
          nextSteps: [
            'Pass --models model-a,model-b',
            'Or set ai.models.default and ai.cognition.modelByTask.plan in config',
          ],
        });
      }

      const report = await benchmarkCognitionModels({
        state,
        config: configResult.config,
        repoRoot: repo.projectRoot,
        models: uniqueModels,
      });
      const nextSteps = ['silvan models recommend'];

      if (options.json) {
        await emitJsonSuccess({
          command: 'models benchmark',
          data: report,
          nextSteps,
          repoRoot: repo.projectRoot,
        });
        return;
      }

      if (options.quiet) {
        return;
      }

      console.log(renderModelBenchmarkReport(report));
    });
}
