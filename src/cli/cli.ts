/* eslint-disable max-lines */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { cac } from 'cac';

import pkg from '../../package.json';
import { createSessionPool } from '../agent/session';
import {
  type AssistSuggestion,
  suggestCliRecovery,
  suggestConfigRecovery,
} from '../ai/cognition/assist';
import { applyCognitionModelRouting } from '../ai/model-routing';
import { type EnvLoadSummary, getLoadedEnvSummary } from '../config/env';
import {
  applyInitSuggestions,
  collectInitContext,
  getInitDefaults,
  hasInitSuggestions,
  promptInitAnswers,
  suggestInitDefaults,
  writeInitConfig,
} from '../config/init';
import { loadConfig } from '../config/load';
import type { Config, ConfigInput } from '../config/schema';
import type { RunContext } from '../core/context';
import { withRunContext } from '../core/context';
import { normalizeError, SilvanError } from '../core/errors';
import { detectRepoContext } from '../core/repo';
import { formatRepoLabel } from '../core/repo-label';
import { runPlanner } from '../core/run-controller';
import { createEnvelope } from '../events/emit';
import type { EventMode, RunStep } from '../events/schema';
import { PRIORITY_MAX, PRIORITY_MIN } from '../queue/priority';
import { deriveConvergenceFromSnapshot } from '../run/controls';
import {
  loadOnboardingState,
  markFirstRunCompleted,
  markQuickstartCompleted,
} from '../state/onboarding';
import { initStateStore } from '../state/store';
import { type LocalTaskInput } from '../task/providers/local';
import { resolveTask } from '../task/resolve';
import { confirmAction } from '../utils/confirm';
import { registerAgentCommands } from './commands/agent';
import { registerAnalyticsCommands } from './commands/analytics';
import { registerCompletionCommand } from './commands/completion';
import { registerConfigCommands } from './commands/config';
import { registerConversationCommands } from './commands/conversation';
import { registerDoctorCommands } from './commands/doctor';
import { registerHelpCommand } from './commands/help';
import { registerLearningCommands } from './commands/learning';
import { registerLogCommands } from './commands/logs';
import { registerModelCommands } from './commands/models';
import { registerQueueCommands } from './commands/queue';
import { registerReviewCommands } from './commands/review';
import { registerRunCommands } from './commands/run';
import { registerTaskCommands, startTaskFlow } from './commands/task';
import { registerTreeCommands } from './commands/tree';
import { registerUiCommands } from './commands/ui';
import { renderCliError } from './errors';
import { buildHelpSections } from './help-output';
import {
  renderInitAssist,
  renderInitDetection,
  renderInitExistingConfig,
  renderInitHeader,
  renderInitResult,
} from './init-output';
import { emitJsonError, emitJsonResult, emitJsonSuccess } from './json-output';
import { buildEmitContext, createCliLogger } from './logger';
import { renderSectionHeader } from './output';
import {
  type QuickstartCheck,
  type QuickstartRunSummary,
  renderFirstRunWelcome,
  renderQuickstartChecks,
  renderQuickstartHeader,
  renderQuickstartMissingRequirements,
  renderQuickstartStep,
  renderReturningSummary,
  renderWorkflowOverview,
} from './quickstart-output';
import { deriveRunListStatus } from './run-list-output';
import {
  renderNextSteps,
  renderPlanSummary,
  renderReadySection,
  renderTaskHeader,
  summarizePlan,
} from './task-start-output';
import type { CliOptions } from './types';

const cli = cac('silvan');

cli.help((sections) => buildHelpSections(sections, cli));
cli.version(pkg.version, '--version, -V');

// Essential options (shown in default help)
cli.option('--json', 'Output JSON events (com.silvan.events)');
cli.option('--yes, -y', 'Skip all confirmation prompts');
cli.option('--no-ui', 'Disable interactive UI');
cli.option('--quiet, -q', 'Suppress non-error output');
cli.option('--verbose, -v', 'Show debug-level output');
cli.option('--debug', 'Show stack traces for errors');
cli.option('--trace', 'Show error causes and stack traces');

// Auth tokens
cli.option('--github-token <token>', 'GitHub token (env: GITHUB_TOKEN)');
cli.option('--linear-token <token>', 'Linear token (env: LINEAR_API_KEY)');

// Model selection (use config file for phase-specific overrides)
cli.option('--model <model>', 'Claude model (default: claude-sonnet-4-20250514)');

// Budget limits
cli.option('--max-turns <n>', 'Max agent turns per session (default: 50)');
cli.option('--max-budget-usd <n>', 'Max cost in USD per session');

// State storage
cli.option('--state-mode <mode>', 'State storage: "repo" or "global" (default: repo)');

// Advanced options (phase-specific - prefer config file)
cli.option('--model-plan <model>', 'Model for planning phase');
cli.option('--model-execute <model>', 'Model for execution phase');
cli.option('--model-review <model>', 'Model for review phase');
cli.option('--model-verify <model>', 'Model for verification phase');
cli.option('--model-pr <model>', 'Model for PR generation');
cli.option('--model-recovery <model>', 'Model for error recovery');
cli.option('--max-turns-plan <n>', 'Max turns for planning');
cli.option('--max-turns-execute <n>', 'Max turns for execution');
cli.option('--max-turns-review <n>', 'Max turns for review');
cli.option('--max-turns-verify <n>', 'Max turns for verification');
cli.option('--max-turns-pr <n>', 'Max turns for PR generation');
cli.option('--max-turns-recovery <n>', 'Max turns for recovery');
cli.option('--max-budget-usd-plan <n>', 'Max USD for planning');
cli.option('--max-budget-usd-execute <n>', 'Max USD for execution');
cli.option('--max-budget-usd-review <n>', 'Max USD for review');
cli.option('--max-budget-usd-verify <n>', 'Max USD for verification');
cli.option('--max-budget-usd-pr <n>', 'Max USD for PR generation');
cli.option('--max-budget-usd-recovery <n>', 'Max USD for recovery');
cli.option('--max-thinking-tokens <n>', 'Max thinking tokens per session');
cli.option('--max-thinking-tokens-plan <n>', 'Max thinking tokens for planning');
cli.option('--max-thinking-tokens-execute <n>', 'Max thinking tokens for execution');
cli.option('--max-thinking-tokens-review <n>', 'Max thinking tokens for review');
cli.option('--max-thinking-tokens-verify <n>', 'Max thinking tokens for verification');
cli.option('--max-thinking-tokens-pr <n>', 'Max thinking tokens for PR');
cli.option('--max-thinking-tokens-recovery <n>', 'Max thinking tokens for recovery');
cli.option('--max-tool-calls <n>', 'Max tool invocations per session');
cli.option('--max-tool-ms <n>', 'Tool execution timeout in ms');
cli.option('--max-review-loops <n>', 'Max review iterations (default: 3)');
cli.option('--persist-sessions', 'Keep agent sessions across phases');
cli.option('--verify-shell <path>', 'Shell for verification commands');

// Cognition provider (advanced - prefer config file)
cli.option('--cognition-provider <provider>', 'AI provider: anthropic, openai, gemini');
cli.option('--cognition-model-kickoff <model>', 'Model for kickoff prompts');
cli.option('--cognition-model-plan <model>', 'Model for plan generation');
cli.option('--cognition-model-review <model>', 'Model for code review');
cli.option('--cognition-model-ci <model>', 'Model for CI triage');
cli.option('--cognition-model-verify <model>', 'Model for verification summary');
cli.option('--cognition-model-recovery <model>', 'Model for error recovery');
cli.option('--cognition-model-pr <model>', 'Model for PR drafts');
cli.option(
  '--cognition-model-conversation-summary <model>',
  'Model for conversation summaries',
);

cli
  .command('init', 'Initialize silvan.config.ts with guided prompts')
  .option('--yes', 'Skip prompts and use defaults')
  .option('--assist', 'Use cognition to suggest defaults')
  // eslint-disable-next-line complexity
  .action(async (options: CliOptions) => {
    const configResult = await loadConfig(buildConfigOverrides(options), {
      cwd: process.cwd(),
    });
    const repo = await detectRepoContext({ cwd: configResult.projectRoot });
    const jsonMode = Boolean(options.json);
    const useDefaults = options.yes ?? jsonMode ?? false;
    const showOutput = !options.quiet && !jsonMode;
    const assistEnabled =
      Boolean(options.assist) || configResult.config.features.cognitionDefaults;

    const context = await collectInitContext(repo.projectRoot);
    let assistResult = null;
    let assistError: string | null = null;
    let defaults = getInitDefaults(context);
    let assistApplied = false;

    if (assistEnabled) {
      try {
        assistResult = await suggestInitDefaults({
          context,
          config: configResult.config,
        });
        if (assistResult && hasInitSuggestions(assistResult.suggestions)) {
          assistApplied = true;
          defaults = applyInitSuggestions(defaults, assistResult.suggestions);
        }
      } catch (error) {
        assistError = error instanceof Error ? error.message : String(error);
      }
    }
    if (showOutput) {
      console.log(renderInitHeader());
      console.log(renderInitDetection(context));
      if (assistEnabled) {
        console.log(
          renderInitAssist(assistResult, { applied: assistApplied, error: assistError }),
        );
      }
    }

    const answers = useDefaults
      ? defaults
      : await promptInitAnswers(context, { defaults });

    let result;
    if (context.existingConfigPath && context.existingConfig) {
      const preview = await writeInitConfig(context, answers, {
        updateExisting: false,
      });
      if (showOutput) {
        console.log(renderInitExistingConfig(context, preview.changes));
      }

      if (preview.changes && preview.changes.length > 0) {
        const shouldUpdate = useDefaults
          ? true
          : await confirmAction('Add missing settings to config?', {
              defaultValue: true,
            });
        result = shouldUpdate
          ? await writeInitConfig(context, answers, { updateExisting: true })
          : preview;
      } else {
        result = preview;
      }
    } else {
      result = await writeInitConfig(context, answers);
    }

    if (showOutput) {
      console.log(renderInitResult(result));
    }

    const nextSteps = [
      'Add tokens to .env (GITHUB_TOKEN, LINEAR_API_KEY, ANTHROPIC_API_KEY)',
      'silvan doctor',
      'silvan task start "Your first task"',
    ];
    if (jsonMode) {
      await emitJsonSuccess({
        command: 'init',
        data: {
          detection: context.detection,
          existingConfigPath: context.existingConfigPath ?? null,
          result,
          assistant: {
            enabled: assistEnabled,
            applied: assistApplied,
            notes: assistResult?.notes ?? [],
            error: assistError,
          },
        },
        nextSteps,
        repoRoot: repo.projectRoot,
      });
    } else if (showOutput) {
      console.log(renderNextSteps(nextSteps));
    }
  });

cli
  .command('quickstart', 'Guided setup and sample plan')
  .option('--yes', 'Skip prompts and use defaults')
  .option('--assist', 'Use cognition to suggest defaults')
  // eslint-disable-next-line complexity
  .action(async (options: CliOptions) => {
    const jsonMode = Boolean(options.json);
    const showOutput = !options.quiet && !jsonMode;
    const useDefaults = options.yes ?? jsonMode;
    const promptAllowed =
      process.stdin.isTTY && !options.quiet && !jsonMode && !useDefaults;

    if (!promptAllowed && !useDefaults) {
      throw new SilvanError({
        code: 'quickstart.non_interactive',
        message: 'Quickstart requires a TTY or --yes.',
        userMessage: 'Quickstart requires a TTY or --yes.',
        kind: 'validation',
        nextSteps: ['Re-run with --yes to accept defaults.'],
      });
    }

    const configResult = await loadConfig(buildConfigOverrides(options), {
      cwd: process.cwd(),
    });
    const assistEnabled =
      Boolean(options.assist) || configResult.config.features.cognitionDefaults;
    let repo;
    try {
      repo = await detectRepoContext({ cwd: configResult.projectRoot });
    } catch {
      throw new SilvanError({
        code: 'quickstart.no_repo',
        message: 'Quickstart must be run inside a git repository.',
        userMessage: 'Quickstart must be run inside a git repository.',
        kind: 'validation',
        nextSteps: ['Run `git init` or change to a git repository first.'],
      });
    }

    const context = await collectInitContext(repo.projectRoot);
    let assistResult = null;
    let assistError: string | null = null;
    let assistApplied = false;
    let defaults = getInitDefaults(context);
    if (assistEnabled) {
      try {
        assistResult = await suggestInitDefaults({
          context,
          config: configResult.config,
        });
        if (assistResult && hasInitSuggestions(assistResult.suggestions)) {
          assistApplied = true;
          defaults = applyInitSuggestions(defaults, assistResult.suggestions);
        }
      } catch (error) {
        assistError = error instanceof Error ? error.message : String(error);
      }
    }
    const envSummary = getLoadedEnvSummary();
    const checkSummary = buildQuickstartChecks({
      repoRoot: repo.projectRoot,
      config: configResult.config,
      envSummary,
      ...(context.existingConfigPath ? { configPath: context.existingConfigPath } : {}),
    });

    const jsonSummary: {
      ok: boolean;
      checks: QuickstartCheck[];
      config?: {
        action: string;
        path?: string;
        backupPath?: string;
        changes?: string[];
      };
      sample?: {
        skipped?: boolean;
        reason?: string;
        runId?: string;
        worktreePath?: string;
        worktreeName?: string;
      };
      assistant?: {
        enabled: boolean;
        applied: boolean;
        notes: string[];
        error: string | null;
      };
      nextSteps?: string[];
    } = {
      ok: checkSummary.blockers.length === 0,
      checks: checkSummary.checks,
    };
    jsonSummary.assistant = {
      enabled: assistEnabled,
      applied: assistApplied,
      notes: assistResult?.notes ?? [],
      error: assistError,
    };

    if (showOutput) {
      console.log(renderQuickstartHeader());
      console.log(
        renderQuickstartChecks(checkSummary.checks, {
          title: 'Step 1: Environment check',
        }),
      );
    }

    if (checkSummary.blockers.length > 0) {
      if (showOutput) {
        console.log('');
        if (checkSummary.requiredKey) {
          console.log(
            renderQuickstartMissingRequirements({
              providerLabel: checkSummary.requiredKey.providerLabel,
              envVar: checkSummary.requiredKey.envVar,
              url: checkSummary.requiredKey.url,
            }),
          );
        } else {
          console.log(
            renderSectionHeader('Missing required setup', { width: 60, kind: 'minor' }),
          );
          for (const blocker of checkSummary.blockers) {
            console.log(`- ${blocker.label}: ${blocker.detail}`);
          }
        }
        console.log(renderNextSteps(['silvan quickstart']));
      }
      if (jsonMode) {
        await emitJsonResult({
          command: 'quickstart',
          success: false,
          data: jsonSummary,
          error: {
            code: 'quickstart.blocked',
            message: 'Missing required setup.',
            details: { blockers: checkSummary.blockers },
            suggestions: ['Run `silvan quickstart` after fixing blockers.'],
          },
          repoRoot: repo.projectRoot,
        });
      }
      process.exitCode = 1;
      return;
    }

    if (showOutput && checkSummary.warnings.length > 0) {
      const notes = buildQuickstartNotes(checkSummary.checks);
      if (notes.length > 0) {
        console.log('');
        for (const note of notes) {
          console.log(note);
        }
      }
    }

    if (promptAllowed) {
      const proceed = await confirmAction('Continue?', { defaultValue: true });
      if (!proceed) {
        if (jsonMode) {
          jsonSummary.sample = { skipped: true, reason: 'user_canceled' };
          await emitJsonResult({
            command: 'quickstart',
            success: jsonSummary.ok,
            data: jsonSummary,
            repoRoot: repo.projectRoot,
          });
        }
        return;
      }
    }

    if (showOutput) {
      console.log('');
      console.log(renderQuickstartStep('Step 2: Configuration'));
      console.log(renderInitDetection(context));
      if (assistEnabled) {
        console.log(
          renderInitAssist(assistResult, { applied: assistApplied, error: assistError }),
        );
      }
    }

    const answers = useDefaults
      ? defaults
      : await promptInitAnswers(context, { defaults });
    let configResultSummary;
    if (context.existingConfigPath && context.existingConfig) {
      const preview = await writeInitConfig(context, answers, {
        updateExisting: false,
      });
      if (showOutput) {
        console.log(renderInitExistingConfig(context, preview.changes));
      }

      if (preview.changes && preview.changes.length > 0) {
        const shouldUpdate = useDefaults
          ? true
          : await confirmAction('Add missing settings to config?', {
              defaultValue: true,
            });
        configResultSummary = shouldUpdate
          ? await writeInitConfig(context, answers, { updateExisting: true })
          : preview;
      } else {
        configResultSummary = preview;
      }
    } else {
      configResultSummary = await writeInitConfig(context, answers);
    }

    jsonSummary.config = {
      action: configResultSummary.action,
      ...(configResultSummary.path ? { path: configResultSummary.path } : {}),
      ...(configResultSummary.backupPath
        ? { backupPath: configResultSummary.backupPath }
        : {}),
      ...(configResultSummary.changes ? { changes: configResultSummary.changes } : {}),
    };

    if (showOutput) {
      console.log(renderInitResult(configResultSummary));
      console.log('');
      console.log(renderWorkflowOverview());
    }

    const shouldRunSample =
      !jsonMode &&
      (useDefaults
        ? true
        : await confirmAction('Generate sample plan?', { defaultValue: true }));

    if (!shouldRunSample) {
      jsonSummary.sample = {
        skipped: true,
        reason: jsonMode ? 'json_mode' : 'user_skipped',
      };
      if (showOutput) {
        console.log('');
        console.log(renderQuickstartStep('Step 4: Sample plan'));
        console.log('Skipping sample plan.');
      }
    } else {
      if (showOutput) {
        console.log('');
        console.log(renderQuickstartStep('Step 4: Sample plan'));
        console.log('Generating a sample plan (no files will be changed)...');
      }
      await withCliContext(options, 'headless', async (ctx) =>
        withAgentSessions(Boolean(ctx.config.ai.sessions.persist), async (sessions) => {
          const sampleResult = await runQuickstartSample({
            ctx,
            sessions,
            input: buildSampleTaskInput(),
          });
          jsonSummary.sample = {
            runId: sampleResult.runId,
            ...(sampleResult.worktreePath
              ? { worktreePath: sampleResult.worktreePath }
              : {}),
            ...(sampleResult.worktreeName
              ? { worktreeName: sampleResult.worktreeName }
              : {}),
          };
          if (showOutput) {
            console.log(
              renderReadySection({
                title: 'Sample plan generated',
                runId: sampleResult.runId,
                ...(sampleResult.worktreePath
                  ? { worktreePath: sampleResult.worktreePath }
                  : {}),
              }),
            );
          }
        }),
      );
    }

    jsonSummary.nextSteps = buildQuickstartNextSteps({
      ...(jsonSummary.sample ? { sample: jsonSummary.sample } : {}),
    });

    if (showOutput) {
      console.log('');
      console.log(renderQuickstartStep("Step 5: What's next"));
      console.log(
        buildQuickstartNextStepsText({
          ...(jsonSummary.sample ? { sample: jsonSummary.sample } : {}),
        }),
      );
    }

    await markQuickstartCompleted(pkg.version);

    if (jsonMode) {
      await emitJsonResult({
        command: 'quickstart',
        success: jsonSummary.ok,
        data: jsonSummary,
        repoRoot: repo.projectRoot,
      });
    }
  });

function parseNumberFlag(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseListFlag(value: string | undefined): string[] | null {
  if (!value) return null;
  const items = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : null;
}

function parseCsvFlag(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function parseModelList(value: string | undefined): string[] | null {
  if (!value) return null;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : null;
}

function collectBenchmarkModels(config: Config): string[] {
  const models = new Set<string>();
  if (config.ai.cognition.modelByTask.plan) {
    models.add(config.ai.cognition.modelByTask.plan);
  }
  if (config.ai.models.plan) {
    models.add(config.ai.models.plan);
  }
  if (config.ai.models.default) {
    models.add(config.ai.models.default);
  }
  for (const model of Object.values(config.ai.cognition.modelByTask)) {
    if (model) models.add(model);
  }
  return Array.from(models);
}

function parseConcurrency(value: string | undefined, fallback = 1): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    throw new SilvanError({
      code: 'queue.invalid_concurrency',
      message: `Invalid concurrency value: ${value}`,
      userMessage: 'Queue concurrency must be a whole number of 1 or higher.',
      kind: 'validation',
      nextSteps: ['Use --concurrency 1 or higher.'],
    });
  }
  return parsed;
}

function parseQueuePriority(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < PRIORITY_MIN ||
    parsed > PRIORITY_MAX
  ) {
    throw new SilvanError({
      code: 'queue.invalid_priority',
      message: `Invalid priority value: ${value}`,
      userMessage: `Queue priority must be a whole number between ${PRIORITY_MIN} and ${PRIORITY_MAX}.`,
      kind: 'validation',
      nextSteps: [
        `Use --priority ${PRIORITY_MIN}-${PRIORITY_MAX}.`,
        'Example: silvan task start "Your task" --priority 8',
      ],
    });
  }
  return parsed;
}

type CognitionKey = {
  providerLabel: string;
  envVar: string;
  url: string;
};

function resolveCognitionKey(config: Config): CognitionKey {
  switch (config.ai.cognition.provider) {
    case 'openai':
      return {
        providerLabel: 'OpenAI',
        envVar: 'OPENAI_API_KEY',
        url: 'https://platform.openai.com/account/api-keys',
      };
    case 'gemini':
      return {
        providerLabel: 'Gemini',
        envVar: 'GEMINI_API_KEY',
        url: 'https://aistudio.google.com/app/apikey',
      };
    case 'anthropic':
    default:
      return {
        providerLabel: 'Anthropic',
        envVar: 'ANTHROPIC_API_KEY',
        url: 'https://console.anthropic.com/',
      };
  }
}

function formatEnvDetail(keys: string[], envSummary: EnvLoadSummary | null): string {
  const fromEnv = envSummary?.keys.some((key) => keys.includes(key));
  return fromEnv ? 'Set (from .env)' : 'Set';
}

function buildQuickstartChecks(options: {
  repoRoot: string;
  config: Config;
  configPath?: string;
  envSummary: EnvLoadSummary | null;
}): {
  checks: QuickstartCheck[];
  blockers: QuickstartCheck[];
  warnings: QuickstartCheck[];
  requiredKey?: CognitionKey;
} {
  const checks: QuickstartCheck[] = [];
  checks.push({
    label: 'Git repository',
    status: 'ok',
    detail: `Detected at ${options.repoRoot}`,
  });

  const bunPath = Bun.which('bun');
  const bunVersion = typeof Bun.version === 'string' ? Bun.version : 'unknown';
  checks.push({
    label: 'Bun',
    status: bunPath ? 'ok' : 'fail',
    detail: bunPath ? `v${bunVersion}` : 'Not found',
  });

  const cognitionKey = resolveCognitionKey(options.config);
  const hasCognitionKey = Boolean(Bun.env[cognitionKey.envVar]);
  checks.push({
    label: `${cognitionKey.providerLabel} API key`,
    status: hasCognitionKey ? 'ok' : 'fail',
    detail: hasCognitionKey
      ? formatEnvDetail([cognitionKey.envVar], options.envSummary)
      : `Missing ${cognitionKey.envVar}`,
  });

  const githubToken = options.config.github.token;
  checks.push({
    label: 'GITHUB_TOKEN',
    status: githubToken ? 'ok' : 'warn',
    detail: githubToken
      ? formatEnvDetail(['GITHUB_TOKEN', 'GH_TOKEN'], options.envSummary)
      : 'Not set (optional for PR automation)',
  });

  const linearToken = options.config.linear.token;
  checks.push({
    label: 'LINEAR_API_KEY',
    status: linearToken ? 'ok' : 'warn',
    detail: linearToken
      ? formatEnvDetail(['LINEAR_API_KEY'], options.envSummary)
      : 'Not set (optional for Linear integration)',
  });

  checks.push({
    label: 'silvan.config',
    status: options.configPath ? 'ok' : 'warn',
    detail: options.configPath
      ? `Found at ${options.configPath}`
      : 'Not found (will create)',
  });

  const blockers = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');

  return {
    checks,
    blockers,
    warnings,
    ...(hasCognitionKey ? {} : { requiredKey: cognitionKey }),
  };
}

function buildQuickstartNotes(checks: QuickstartCheck[]): string[] {
  const notes: string[] = [];
  const githubMissing = checks.some(
    (check) => check.label === 'GITHUB_TOKEN' && check.status === 'warn',
  );
  const linearMissing = checks.some(
    (check) => check.label === 'LINEAR_API_KEY' && check.status === 'warn',
  );

  if (githubMissing) {
    notes.push('Note: Set GITHUB_TOKEN to enable automatic PR creation.');
    notes.push('Get one at: https://github.com/settings/tokens');
  }

  if (linearMissing) {
    notes.push('Note: Set LINEAR_API_KEY to enable Linear task sync.');
    notes.push('Get one at: https://linear.app/settings/api');
  }

  return notes;
}

async function maybeSuggestCliRecovery(options: {
  error: SilvanError;
  command?: string;
}): Promise<AssistSuggestion | null> {
  if (options.error.kind === 'canceled') return null;
  try {
    if (options.error.code?.startsWith('config.')) {
      return await suggestConfigRecovery({
        error: options.error,
        repoRoot: process.cwd(),
      });
    }
    return await suggestCliRecovery({
      error: options.error,
      repoRoot: process.cwd(),
      ...(options.command !== undefined ? { command: options.command } : {}),
    });
  } catch {
    return null;
  }
}

// eslint-disable-next-line complexity
function buildConfigOverrides(options: CliOptions): ConfigInput {
  const overrides: ConfigInput = {};

  if (options.githubToken) {
    overrides.github = { ...(overrides.github ?? {}), token: options.githubToken };
  }
  if (options.linearToken) {
    overrides.linear = { ...(overrides.linear ?? {}), token: options.linearToken };
  }
  if (options.verifyShell) {
    overrides.verify = { ...(overrides.verify ?? {}), shell: options.verifyShell };
  }
  if (options.stateMode) {
    if (options.stateMode !== 'global' && options.stateMode !== 'repo') {
      throw new Error(`Invalid --state-mode value: ${options.stateMode}`);
    }
    overrides.state = { ...(overrides.state ?? {}), mode: options.stateMode };
  }
  if (options.persistSessions === true) {
    overrides.ai = {
      ...(overrides.ai ?? {}),
      sessions: { ...(overrides.ai?.sessions ?? {}), persist: options.persistSessions },
    };
  }

  if (options.model) {
    overrides.ai = {
      ...(overrides.ai ?? {}),
      models: { ...(overrides.ai?.models ?? {}), default: options.model },
    };
  }
  const phaseModels: Array<
    [keyof NonNullable<Config['ai']>['models'], string | undefined]
  > = [
    ['plan', options.modelPlan],
    ['execute', options.modelExecute],
    ['review', options.modelReview],
    ['verify', options.modelVerify],
    ['pr', options.modelPr],
    ['recovery', options.modelRecovery],
  ];
  for (const [phase, value] of phaseModels) {
    if (!value) continue;
    overrides.ai = {
      ...(overrides.ai ?? {}),
      models: { ...(overrides.ai?.models ?? {}), [phase]: value },
    };
  }

  if (options.cognitionProvider) {
    overrides.ai = {
      ...(overrides.ai ?? {}),
      cognition: {
        ...(overrides.ai?.cognition ?? {}),
        provider: options.cognitionProvider as Config['ai']['cognition']['provider'],
      },
    };
  }

  const cognitionModels: Array<
    [keyof NonNullable<Config['ai']>['cognition']['modelByTask'], string | undefined]
  > = [
    ['kickoffPrompt', options.cognitionModelKickoff],
    ['plan', options.cognitionModelPlan],
    ['reviewKickoff', options.cognitionModelReview],
    ['reviewCluster', options.cognitionModelReview],
    ['ciTriage', options.cognitionModelCi],
    ['verificationSummary', options.cognitionModelVerify],
    ['verificationFix', options.cognitionModelVerify],
    ['recovery', options.cognitionModelRecovery],
    ['prDraft', options.cognitionModelPr],
    ['conversationSummary', options.cognitionModelConversationSummary],
  ];
  for (const [task, value] of cognitionModels) {
    if (!value) continue;
    overrides.ai = {
      ...(overrides.ai ?? {}),
      cognition: {
        ...(overrides.ai?.cognition ?? {}),
        modelByTask: {
          ...(overrides.ai?.cognition?.modelByTask ?? {}),
          [task]: value,
        },
      },
    };
  }

  const defaultBudget = {
    maxTurns: parseNumberFlag(options.maxTurns),
    maxBudgetUsd: parseNumberFlag(options.maxBudgetUsd),
    maxThinkingTokens: parseNumberFlag(options.maxThinkingTokens),
  };
  if (
    defaultBudget.maxTurns ||
    defaultBudget.maxBudgetUsd ||
    defaultBudget.maxThinkingTokens
  ) {
    overrides.ai = {
      ...(overrides.ai ?? {}),
      budgets: {
        ...(overrides.ai?.budgets ?? {}),
        default: {
          ...(overrides.ai?.budgets?.default ?? {}),
          ...(defaultBudget.maxTurns ? { maxTurns: defaultBudget.maxTurns } : {}),
          ...(defaultBudget.maxBudgetUsd
            ? { maxBudgetUsd: defaultBudget.maxBudgetUsd }
            : {}),
          ...(defaultBudget.maxThinkingTokens
            ? { maxThinkingTokens: defaultBudget.maxThinkingTokens }
            : {}),
        },
      },
    };
  }

  const phaseBudgets: Array<
    [
      keyof NonNullable<Config['ai']>['budgets'],
      string | undefined,
      string | undefined,
      string | undefined,
    ]
  > = [
    [
      'plan',
      options.maxTurnsPlan,
      options.maxBudgetUsdPlan,
      options.maxThinkingTokensPlan,
    ],
    [
      'execute',
      options.maxTurnsExecute,
      options.maxBudgetUsdExecute,
      options.maxThinkingTokensExecute,
    ],
    [
      'review',
      options.maxTurnsReview,
      options.maxBudgetUsdReview,
      options.maxThinkingTokensReview,
    ],
    [
      'verify',
      options.maxTurnsVerify,
      options.maxBudgetUsdVerify,
      options.maxThinkingTokensVerify,
    ],
    ['pr', options.maxTurnsPr, options.maxBudgetUsdPr, options.maxThinkingTokensPr],
    [
      'recovery',
      options.maxTurnsRecovery,
      options.maxBudgetUsdRecovery,
      options.maxThinkingTokensRecovery,
    ],
  ];
  for (const [phase, turns, budget, thinking] of phaseBudgets) {
    const maxTurns = parseNumberFlag(turns);
    const maxBudgetUsd = parseNumberFlag(budget);
    const maxThinkingTokens = parseNumberFlag(thinking);
    if (!maxTurns && !maxBudgetUsd && !maxThinkingTokens) continue;
    overrides.ai = {
      ...(overrides.ai ?? {}),
      budgets: {
        ...(overrides.ai?.budgets ?? {}),
        [phase]: {
          ...(overrides.ai?.budgets?.[phase] ?? {}),
          ...(maxTurns ? { maxTurns } : {}),
          ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
          ...(maxThinkingTokens ? { maxThinkingTokens } : {}),
        },
      },
    };
  }

  const maxToolCalls = parseNumberFlag(options.maxToolCalls);
  const maxToolMs = parseNumberFlag(options.maxToolMs);
  if (maxToolCalls || maxToolMs) {
    overrides.ai = {
      ...(overrides.ai ?? {}),
      toolLimits: {
        ...(overrides.ai?.toolLimits ?? {}),
        ...(maxToolCalls ? { maxCalls: maxToolCalls } : {}),
        ...(maxToolMs ? { maxDurationMs: maxToolMs } : {}),
      },
    };
  }

  const maxReviewLoops = parseNumberFlag(options.maxReviewLoops);
  if (maxReviewLoops) {
    overrides.review = { ...(overrides.review ?? {}), maxIterations: maxReviewLoops };
  }

  return overrides;
}

async function withCliContext<T>(
  options: CliOptions | undefined,
  mode: EventMode,
  fn: (ctx: RunContext) => Promise<T>,
  extra?: { lock?: boolean; runId?: string; modelRouting?: boolean },
): Promise<T> {
  const configOverrides = buildConfigOverrides(options ?? {});
  return withRunContext(
    { cwd: process.cwd(), mode, configOverrides, ...(extra ?? {}) },
    async (ctx) => {
      if (extra?.modelRouting !== false) {
        const routingDecision = await applyCognitionModelRouting({
          state: ctx.state,
          config: ctx.config,
          runId: ctx.runId,
          bus: ctx.events.bus,
          context: buildEmitContext(ctx),
        });
        ctx.config = routingDecision.config;
      }
      return fn(ctx);
    },
  );
}

registerHelpCommand(cli);

registerHelpCommand(cli);

// Worktree commands - aliased as both 'tree' and 't'
registerTreeCommands(cli, {
  withCliContext,
  runStep,
});

registerReviewCommands(cli, {
  withCliContext,
  runStep,
  persistRunState,
});

registerRunCommands(cli, {
  withCliContext,
  withAgentSessions,
  buildConfigOverrides,
  parseListFlag,
  parseNumberFlag,
});

registerAnalyticsCommands(cli, {
  buildConfigOverrides,
  parseListFlag,
});

registerModelCommands(cli, {
  buildConfigOverrides,
  parseNumberFlag,
  parseModelList,
  collectBenchmarkModels,
});

registerLogCommands(cli, {
  buildConfigOverrides,
  parseNumberFlag,
});

registerLearningCommands(cli, {
  withCliContext,
  parseCsvFlag,
});

registerUiCommands(cli, {
  withCliContext,
});

registerTaskCommands(cli, {
  withCliContext,
  withAgentSessions,
  parseQueuePriority,
});

registerQueueCommands(cli, {
  withCliContext,
  createCliLogger,
  buildConfigOverrides,
  parseConcurrency,
  parseQueuePriority,
  withAgentSessions,
  startTaskFlow,
});

type QuickstartSampleInfo = {
  runId?: string;
  worktreePath?: string;
  worktreeName?: string;
  skipped?: boolean;
  reason?: string;
};

type QuickstartSampleResult = {
  runId: string;
  worktreePath?: string;
  worktreeName?: string;
};

function buildSampleTaskInput(): LocalTaskInput {
  return {
    title: 'Review the repository and propose improvements',
    description:
      'Review the repository structure and outline a brief plan without changing files.',
    acceptanceCriteria: [
      'Summarize the repository layout and key entry points.',
      'List up to three improvement ideas.',
      'Confirm no files were changed.',
    ],
  };
}

async function runQuickstartSample(options: {
  ctx: RunContext;
  sessions?: ReturnType<typeof createSessionPool>;
  input: LocalTaskInput;
}): Promise<QuickstartSampleResult> {
  const ctx = options.ctx;
  const mode = ctx.events.mode;
  const logger = createCliLogger(ctx);

  const resolved = await runStep(ctx, 'task.resolve', 'Resolving task', () =>
    resolveTask(options.input.title, {
      config: ctx.config,
      repoRoot: ctx.repo.repoRoot,
      state: ctx.state,
      runId: ctx.runId,
      localInput: options.input,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
    }),
  );

  await logger.info(renderTaskHeader(resolved.task));

  const plan = await runPlanner(ctx, {
    taskRef: resolved.ref.raw,
    task: resolved.task,
    allowMissingClarifications: true,
    ...(options.sessions ? { sessions: options.sessions } : {}),
  });

  const planSummary = summarizePlan(plan);
  await logger.info(renderPlanSummary(planSummary));

  return {
    runId: ctx.runId,
  };
}

function buildQuickstartNextSteps(options: { sample?: QuickstartSampleInfo }): string[] {
  const steps: string[] = [];
  if (options.sample?.runId) {
    steps.push(`silvan run inspect ${options.sample.runId}`);
  }
  if (options.sample?.worktreePath) {
    steps.push(`cd ${options.sample.worktreePath}`);
    steps.push('silvan agent run --apply');
  }
  if (options.sample?.worktreeName) {
    steps.push(`silvan tree remove ${options.sample.worktreeName}`);
  }
  steps.push('silvan task start "Your actual task description"');
  steps.push('silvan run list');
  steps.push('silvan help');
  return steps;
}

function buildQuickstartNextStepsText(options: {
  sample?: QuickstartSampleInfo;
}): string {
  const lines: string[] = [];

  if (options.sample?.runId) {
    lines.push('Review the sample plan:');
    lines.push(`  silvan run inspect ${options.sample.runId}`);
    lines.push('');
  }

  if (options.sample?.worktreePath) {
    lines.push('Execute the plan:');
    lines.push(`  cd ${options.sample.worktreePath}`);
    lines.push('  silvan agent run --apply');
    lines.push('');
  }

  if (options.sample?.worktreeName) {
    lines.push('Clean up the sample:');
    lines.push(`  silvan tree remove ${options.sample.worktreeName}`);
    lines.push('');
  }

  lines.push('Start a real task:');
  lines.push('  silvan task start "Your actual task description"');
  lines.push('  silvan task start gh-42');
  lines.push('  silvan task start ENG-99');
  lines.push('');
  lines.push('Learn more:');
  lines.push('  silvan help worktrees');
  lines.push('  silvan help task-refs');
  lines.push('  silvan --help');

  return lines.join('\n');
}

async function collectActiveRuns(
  state: Awaited<ReturnType<typeof initStateStore>>,
): Promise<QuickstartRunSummary[]> {
  const runEntries = await readdir(state.runsDir);
  const files = runEntries.filter((entry) => entry.endsWith('.json'));
  const runs: Array<QuickstartRunSummary & { updatedAt?: string }> = [];

  for (const file of files) {
    const runId = file.replace(/\.json$/, '');
    const snapshot = await state.readRunState(runId);
    if (!snapshot) continue;
    const data = snapshot.data as Record<string, unknown>;
    const run = (typeof data['run'] === 'object' && data['run'] ? data['run'] : {}) as {
      status?: string;
      updatedAt?: string;
    };
    const task = (
      typeof data['task'] === 'object' && data['task'] ? data['task'] : {}
    ) as {
      title?: string;
    };
    const taskRef = (
      typeof data['taskRef'] === 'object' && data['taskRef'] ? data['taskRef'] : {}
    ) as { raw?: string };
    const convergence = deriveConvergenceFromSnapshot(snapshot);
    const status = deriveRunListStatus(run.status, convergence.status);
    if (['success', 'failed', 'canceled'].includes(status)) continue;
    const title = task.title ?? taskRef.raw ?? 'Untitled';
    const runEntry: QuickstartRunSummary & { updatedAt?: string } = {
      runId,
      status,
      title,
      ...(run.updatedAt ? { updatedAt: run.updatedAt } : {}),
    };
    runs.push(runEntry);
  }

  runs.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return runs.slice(0, 5).map(({ runId, status, title }) => ({
    runId,
    status,
    title,
  }));
}

async function buildReturningSummaryData(): Promise<{
  repo?: string;
  runs?: QuickstartRunSummary[];
}> {
  try {
    const configResult = await loadConfig(undefined, { cwd: process.cwd() });
    const repo = await detectRepoContext({ cwd: configResult.projectRoot });
    const state = await initStateStore(repo.projectRoot, {
      lock: false,
      mode: configResult.config.state.mode,
      ...(configResult.config.state.root ? { root: configResult.config.state.root } : {}),
      metadataRepoRoot: repo.gitRoot,
    });
    const runs = await collectActiveRuns(state);
    await state.lockRelease();
    return {
      repo: formatRepoLabel(configResult.config, repo.projectRoot),
      runs,
    };
  } catch {
    return {};
  }
}

async function handleRootCommand(options: CliOptions): Promise<void> {
  const onboarding = await loadOnboardingState();
  const firstRun = !onboarding.firstRunCompleted && !onboarding.quickstartCompleted;

  if (options.json) {
    const summary = firstRun ? {} : await buildReturningSummaryData();
    const payload = {
      firstRun,
      quickstartCompleted: Boolean(onboarding.quickstartCompleted),
      ...(summary.repo ? { repo: summary.repo } : {}),
      ...(summary.runs ? { activeRuns: summary.runs } : {}),
    };
    await emitJsonSuccess({
      command: 'silvan',
      data: payload,
    });
    if (firstRun) {
      await markFirstRunCompleted(pkg.version);
    }
    return;
  }

  if (options.quiet) {
    if (firstRun) {
      await markFirstRunCompleted(pkg.version);
    }
    return;
  }

  if (firstRun) {
    console.log(renderFirstRunWelcome());
    await markFirstRunCompleted(pkg.version);
    return;
  }

  const summary = await buildReturningSummaryData();
  console.log(renderReturningSummary(summary));
}

registerAgentCommands(cli, {
  withCliContext,
  withAgentSessions,
  persistRunState,
});

// Shell completion
registerCompletionCommand(cli);

registerConfigCommands(cli, {
  buildConfigOverrides,
  maybeSuggestCliRecovery,
  getRegisteredCommandNames,
});

registerDoctorCommands(cli, {
  withCliContext,
});

registerConversationCommands(cli, {
  withCliContext,
});

// Command aliases: short names for common commands
const COMMAND_ALIASES: Record<string, string> = {
  t: 'tree',
  wt: 'tree',
  r: 'run',
  a: 'agent',
};

function expandAliases(argv: string[]): string[] {
  // Find the first non-option argument starting from position 2 (skip "bun" and script path)
  const expanded = [...argv];
  for (let i = 2; i < expanded.length; i++) {
    const arg = expanded[i];
    if (!arg || arg.startsWith('-')) continue;
    // Check if this is an alias
    const alias = COMMAND_ALIASES[arg];
    if (alias) {
      expanded[i] = alias;
    }
    // Only process the first command word, then stop
    break;
  }
  return expanded;
}

/**
 * Get all registered command names from cac.
 * cac stores commands internally with their full names (including spaces for subcommands).
 */
function getRegisteredCommandNames(): string[] {
  return cli.commands?.map((c: { name: string }) => c.name) ?? [];
}

/**
 * Match multi-word commands by finding the longest registered command name
 * that matches the beginning of argv.
 *
 * For example, if registered commands include "task start" and "task",
 * and argv is ["task", "start", "DEP-159"], this returns "task start"
 * because it's the longest match.
 */
function findMatchingCommand(
  args: string[],
): { commandName: string; wordCount: number } | null {
  const commandNames = getRegisteredCommandNames();

  // Build a map of command names by word count for efficient lookup
  const byWordCount = new Map<number, Set<string>>();
  for (const name of commandNames) {
    const count = name.split(' ').length;
    if (!byWordCount.has(count)) {
      byWordCount.set(count, new Set());
    }
    byWordCount.get(count)!.add(name);
  }

  // Find the maximum word count to check
  const maxWords = Math.max(...byWordCount.keys(), 0);

  // Try matching from longest to shortest (greedy matching)
  for (let wordCount = Math.min(maxWords, args.length); wordCount >= 1; wordCount--) {
    const candidate = args.slice(0, wordCount).join(' ');
    const commandsAtLength = byWordCount.get(wordCount);
    if (commandsAtLength?.has(candidate)) {
      return { commandName: candidate, wordCount };
    }
  }

  return null;
}

/**
 * Transform argv to handle multi-word commands.
 *
 * cac only matches the first arg against command names, so "task start DEP-159"
 * never matches "task start" because cac only sees "task".
 *
 * This function finds multi-word commands and combines them into a single
 * argument that cac can match.
 *
 * Example:
 *   Input:  ["bun", "cli.ts", "task", "start", "DEP-159"]
 *   Output: ["bun", "cli.ts", "task start", "DEP-159"]
 */
function combineMultiWordCommand(argv: string[]): string[] {
  // Find where the command args start (skip "bun", script path, and any leading options)
  let commandStart = 2;
  while (commandStart < argv.length && argv[commandStart]?.startsWith('-')) {
    commandStart++;
  }

  if (commandStart >= argv.length) {
    return argv; // No command found
  }

  // Get the args that might form a command
  const potentialCommandArgs = argv.slice(commandStart);

  // Find the matching command
  const match = findMatchingCommand(potentialCommandArgs);
  if (!match || match.wordCount <= 1) {
    return argv; // No multi-word command or single-word command (cac handles these)
  }

  // Combine the multi-word command into a single argv element
  return [
    ...argv.slice(0, commandStart),
    match.commandName,
    ...argv.slice(commandStart + match.wordCount),
  ];
}

// eslint-disable-next-line complexity
export async function run(argv: string[]): Promise<void> {
  const jsonEnabled = argv.includes('--json');
  if (jsonEnabled) {
    process.env['SILVAN_JSON'] = '1';
  }
  const verboseEnabled = argv.includes('--verbose') || argv.includes('-v');
  const debugEnabled =
    verboseEnabled || argv.includes('--debug') || argv.includes('--trace');
  if (debugEnabled) {
    process.env['SILVAN_DEBUG'] = '1';
  }
  const quietEnabled = argv.includes('--quiet') || argv.includes('-q');
  if (quietEnabled) {
    process.env['SILVAN_QUIET'] = '1';
  }
  const versionRequested = argv.includes('--version') || argv.includes('-V');
  if (versionRequested) {
    if (!quietEnabled) {
      await outputVersionInfo();
    }
    return;
  }

  // Step 1: Expand command aliases (t -> tree, r -> run, etc.)
  const expandedArgv = expandAliases(argv);

  // Step 2: Combine multi-word commands into single args for cac matching
  // e.g., ["task", "start", "DEP-159"] -> ["task start", "DEP-159"]
  const processedArgv = combineMultiWordCommand(expandedArgv);

  // Step 3: Parse with cac
  cli.parse(processedArgv, { run: false });

  try {
    const wantsHelp = argv.includes('--help') || argv.includes('-h');
    const isRootCommand =
      cli.args.length === 0 &&
      (!cli.matchedCommand || cli.matchedCommand.isGlobalCommand);
    if (isRootCommand && !wantsHelp) {
      await handleRootCommand(cli.options as CliOptions);
      return;
    }

    if (!cli.matchedCommand && cli.args.length > 0) {
      const unknownCommand = cli.args.join(' ');
      throw new SilvanError({
        code: 'unknown_command',
        message: `Unknown command: ${unknownCommand}`,
        userMessage: `Unknown command: ${unknownCommand}`,
        kind: 'validation',
        exitCode: 1,
        nextSteps: ['Run `silvan --help` to see available commands.'],
      });
    }

    // Step 4: Run the matched command
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- cac's return type is untyped.
    const runPromise: Promise<unknown> | undefined = cli.runMatchedCommand();

    // runMatchedCommand returns undefined when no command matches (e.g., --help)
    if (runPromise instanceof Promise) {
      await runPromise;
    }
  } catch (error) {
    const normalized = normalizeError(error);
    const assistant = await maybeSuggestCliRecovery({
      error: normalized,
      command: cli.matchedCommand?.name ?? 'silvan',
    });
    const jsonMode = argv.includes('--json');
    if (jsonMode) {
      const commandName = cli.matchedCommand?.name ?? 'silvan';
      await emitJsonError({ command: commandName, error: normalized, assistant });
    } else {
      const debugEnabled = argv.includes('--debug') || argv.includes('--trace');
      const traceEnabled = argv.includes('--trace');
      const rendered = renderCliError(normalized, {
        debug: debugEnabled,
        trace: traceEnabled,
        commandNames: getRegisteredCommandNames(),
        ...(assistant ? { assistant } : {}),
      });
      console.error(rendered.message);
    }
    if (normalized.exitCode !== undefined) {
      process.exitCode = normalized.exitCode;
    } else if (process.exitCode === undefined) {
      process.exitCode = 1;
    }
  }
}

async function outputVersionInfo(): Promise<void> {
  try {
    const { config, source } = await loadConfig();
    const configPath = source?.path ?? 'defaults (no config file found)';
    const model = config.ai.models.default ?? 'auto';
    console.log(`silvan/${pkg.version}`);
    console.log(`Config: ${configPath}`);
    console.log(`Default model: ${model}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`silvan/${pkg.version}`);
    console.log('Config: unavailable');
    console.log(`Error: ${message}`);
  }
}

async function runStep<T>(
  ctx: RunContext,
  stepId: string,
  title: string,
  fn: () => Promise<T>,
): Promise<T> {
  await ctx.events.bus.emit(
    createEnvelope({
      type: 'run.step',
      source: 'engine',
      level: 'info',
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      payload: { stepId, title, status: 'running' } satisfies RunStep,
    }),
  );
  try {
    const result = await fn();
    await ctx.events.bus.emit(
      createEnvelope({
        type: 'run.step',
        source: 'engine',
        level: 'info',
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
        payload: { stepId, title, status: 'succeeded' } satisfies RunStep,
      }),
    );
    return result;
  } catch (error) {
    await ctx.events.bus.emit(
      createEnvelope({
        type: 'run.step',
        source: 'engine',
        level: 'error',
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
        payload: { stepId, title, status: 'failed' } satisfies RunStep,
      }),
    );
    throw error;
  }
}

async function persistRunState(
  ctx: RunContext,
  mode: EventMode,
  updater: (data: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const snapshotId = await ctx.state.updateRunState(ctx.runId, updater);
  await ctx.events.bus.emit(
    createEnvelope({
      type: 'run.persisted',
      source: 'engine',
      level: 'info',
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      payload: {
        path: join(ctx.state.runsDir, `${ctx.runId}.json`),
        snapshotId,
        stateVersion: ctx.state.stateVersion,
      },
    }),
  );
}

async function withAgentSessions<T>(
  enabled: boolean,
  fn: (sessions: ReturnType<typeof createSessionPool>) => Promise<T>,
): Promise<T> {
  const sessions = createSessionPool(enabled);
  try {
    return await fn(sessions);
  } finally {
    sessions.close();
  }
}
/* eslint-enable max-lines */
