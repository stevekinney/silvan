import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { cac } from 'cac';

import pkg from '../../package.json';
import { collectClarifications } from '../agent/clarify';
import { createSessionPool } from '../agent/session';
import {
  exportConversationSnapshot,
  loadConversationSnapshot,
  renderConversationSummary,
  summarizeConversationSnapshot,
} from '../ai/conversation';
import { getInitDefaults, promptInitAnswers, writeInitConfig } from '../config/init';
import { loadConfig } from '../config/load';
import type { Config, ConfigInput } from '../config/schema';
import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import type { RunContext } from '../core/context';
import { withRunContext } from '../core/context';
import { SilvanError } from '../core/errors';
import { createLogger } from '../core/logger';
import { detectRepoContext } from '../core/repo';
import {
  resumeRun,
  runImplementation,
  runPlanner,
  runRecovery,
  runReviewLoop,
} from '../core/run-controller';
import { collectDoctorReport } from '../diagnostics/doctor';
import { createEnvelope, type EmitContext } from '../events/emit';
import type { Event, EventMode, RunStep } from '../events/schema';
import { runGit } from '../git/exec';
import {
  createWorktree,
  hasUncommittedChanges,
  installDependencies,
  listWorktrees,
  lockWorktree,
  normalizeClaudeSettings,
  pruneWorktrees,
  rebaseOntoBase,
  removeWorktree,
  unlockWorktree,
} from '../git/worktree';
import { waitForCi } from '../github/ci';
import { findMergedPr, openOrUpdatePr, requestReviewers } from '../github/pr';
import { fetchUnresolvedReviewComments } from '../github/review';
import {
  deriveConvergenceFromSnapshot,
  loadRunSnapshot,
  markRunAborted,
  writeOverrideArtifact,
} from '../run/controls';
import type { ArtifactEntry } from '../state/artifacts';
import { readArtifact } from '../state/artifacts';
import { deleteQueueRequest, listQueueRequests } from '../state/queue';
import { initStateStore } from '../state/store';
import { promptLocalTaskInput } from '../task/prompt-local-task';
import { type LocalTaskInput, parseLocalTaskFile } from '../task/providers/local';
import { inferTaskRefFromBranch, resolveTask } from '../task/resolve';
import { mountDashboard, startPrSnapshotPoller } from '../ui';
import { confirmAction } from '../utils/confirm';
import { hashString } from '../utils/hash';
import { sanitizeName } from '../utils/slug';
import { buildWorktreeName } from '../utils/worktree-name';
import {
  generateBashCompletion,
  generateFishCompletion,
  generateZshCompletion,
} from './completion';
import { renderCliError } from './errors';

const cli = cac('silvan');

cli.help();
cli.version(pkg.version);

type CliOptions = {
  json?: boolean;
  yes?: boolean;
  force?: boolean;
  all?: boolean;
  interval?: string;
  timeout?: string;
  noUi?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  dangerous?: boolean;
  network?: boolean;
  printCd?: boolean;
  openShell?: boolean;
  exec?: string;
  debug?: boolean;
  trace?: boolean;
  task?: string;
  githubToken?: string;
  linearToken?: string;
  model?: string;
  modelPlan?: string;
  modelExecute?: string;
  modelReview?: string;
  modelVerify?: string;
  modelPr?: string;
  modelRecovery?: string;
  cognitionProvider?: string;
  cognitionModelKickoff?: string;
  cognitionModelPlan?: string;
  cognitionModelReview?: string;
  cognitionModelCi?: string;
  cognitionModelVerify?: string;
  cognitionModelRecovery?: string;
  cognitionModelPr?: string;
  cognitionModelConversationSummary?: string;
  maxTurns?: string;
  maxTurnsPlan?: string;
  maxTurnsExecute?: string;
  maxTurnsReview?: string;
  maxTurnsVerify?: string;
  maxTurnsPr?: string;
  maxTurnsRecovery?: string;
  maxBudgetUsd?: string;
  maxBudgetUsdPlan?: string;
  maxBudgetUsdExecute?: string;
  maxBudgetUsdReview?: string;
  maxBudgetUsdVerify?: string;
  maxBudgetUsdPr?: string;
  maxBudgetUsdRecovery?: string;
  maxThinkingTokens?: string;
  maxThinkingTokensPlan?: string;
  maxThinkingTokensExecute?: string;
  maxThinkingTokensReview?: string;
  maxThinkingTokensVerify?: string;
  maxThinkingTokensPr?: string;
  maxThinkingTokensRecovery?: string;
  maxToolCalls?: string;
  maxToolMs?: string;
  maxReviewLoops?: string;
  persistSessions?: boolean;
  verifyShell?: string;
  stateMode?: string;
  title?: string;
  desc?: string;
  ac?: string[] | string;
  fromFile?: string;
};

// Essential options (shown in default help)
cli.option('--json', 'Output as JSON event stream');
cli.option('--yes, -y', 'Skip all confirmation prompts');
cli.option('--no-ui', 'Disable interactive UI');
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
  .action(async (options: CliOptions) => {
    const chalk = await import('chalk').then((m) => m.default);
    const repo = await detectRepoContext({ cwd: process.cwd() });
    const useDefaults = options.yes ?? false;

    const answers = useDefaults
      ? await getInitDefaults(repo.repoRoot)
      : await promptInitAnswers(repo.repoRoot);

    const result = await writeInitConfig(repo.repoRoot, answers);
    if (!result) {
      console.log(chalk.yellow('silvan.config.ts already exists.'));
      return;
    }

    console.log(chalk.green('✓ ') + `Created ${result.path}`);
  });

function parseNumberFlag(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

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
  extra?: { lock?: boolean; runId?: string },
): Promise<T> {
  const configOverrides = buildConfigOverrides(options ?? {});
  return withRunContext(
    { cwd: process.cwd(), mode, configOverrides, ...(extra ?? {}) },
    fn,
  );
}

// Worktree commands - aliased as both 'tree' and 't'
cli.command('tree list', 'List all git worktrees').action(async (options: CliOptions) => {
  const mode: EventMode = options.json ? 'json' : 'headless';
  await withCliContext(options, mode, async (ctx) => {
    await runStep(ctx, 'git.worktree.list', 'List worktrees', async () =>
      listWorktrees({
        repoRoot: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        includeStatus: true,
      }),
    );
  });
});

cli
  .command('tree add <name>', 'Create a new worktree with branch')
  .action(async (name: string, options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
      const logger = createCliLogger(ctx);
      const safeName = sanitizeName(name);

      const worktree = await runStep(
        ctx,
        'git.worktree.create',
        'Create worktree',
        async () =>
          createWorktree({
            repoRoot: ctx.repo.repoRoot,
            name: safeName,
            config: ctx.config,
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
          }),
      );

      await normalizeClaudeSettings({ worktreePath: worktree.path });

      const installResult = await installDependencies({ worktreePath: worktree.path });
      if (!installResult.ok) {
        await logger.warn(`Warning: bun install failed in ${worktree.path}`, {
          stderr: installResult.stderr,
          stdout: installResult.stdout,
        });
      }
    });
  });

cli
  .command('tree remove [name]', 'Remove a worktree')
  .option('--force', 'Force removal even if dirty')
  .option('--task <task>', 'Remove worktree for a task reference')
  .action(async (name: string | undefined, options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
      const task = options.task ? sanitizeName(options.task) : undefined;
      const targetName = name ? sanitizeName(name) : undefined;
      if (!task && !targetName) {
        throw new Error('Worktree name or --task is required.');
      }

      const worktrees = await runStep(
        ctx,
        'git.worktree.list',
        'List worktrees',
        async () =>
          listWorktrees({
            repoRoot: ctx.repo.repoRoot,
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
            includeStatus: true,
          }),
      );

      const expectedPath = task
        ? join(ctx.repo.repoRoot, ctx.config.naming.worktreeDir, task)
        : null;
      const expectedBranch = task ? `${ctx.config.naming.branchPrefix}${task}` : null;
      const targets = worktrees.filter((worktree) => {
        if (expectedPath && worktree.path === expectedPath) return true;
        if (expectedBranch && worktree.branch === expectedBranch) return true;
        if (targetName && worktree.branch === targetName) return true;
        if (targetName && basename(worktree.path) === targetName) return true;
        return false;
      });

      if (targets.length === 0) {
        throw new Error(`Worktree not found: ${task ?? targetName}`);
      }
      if (targets.length > 1) {
        const paths = targets.map((target) => target.path).join(', ');
        throw new Error(`Worktree name is ambiguous: ${task ?? targetName} (${paths})`);
      }

      const target = targets[0]!;

      if (target.isDirty && !options.force) {
        throw new Error(`Worktree ${name} is dirty. Use --force to remove.`);
      }

      if (!options.yes) {
        const confirmed = await confirmAction(`Remove worktree ${target.path}?`);
        if (!confirmed) {
          console.log('Canceled.');
          return;
        }
      }

      await runStep(ctx, 'git.worktree.remove', 'Remove worktree', async () =>
        removeWorktree({
          repoRoot: ctx.repo.repoRoot,
          path: target.path,
          force: Boolean(options.force),
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        }),
      );
    });
  });

cli
  .command('tree clean', 'Remove worktrees with merged PRs')
  .option('--force', 'Force removal even if dirty')
  .option('--all', 'Remove all merged worktrees without prompting')
  .action(async (options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
      const githubToken = requireGitHubAuth(ctx.config);
      const github = await requireGitHubConfig({
        config: ctx.config,
        repoRoot: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });

      const worktrees = await runStep(
        ctx,
        'git.worktree.list',
        'List worktrees',
        async () =>
          listWorktrees({
            repoRoot: ctx.repo.repoRoot,
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
          }),
      );

      const defaultBranch = ctx.config.repo.defaultBranch;
      const candidates = worktrees.filter((worktree) => {
        if (worktree.path === ctx.repo.repoRoot) return false;
        if (!worktree.branch || worktree.branch === '(detached)') return false;
        if (worktree.branch === defaultBranch) return false;
        return true;
      });

      const merged: Array<{
        worktree: (typeof candidates)[number];
        pr: NonNullable<Awaited<ReturnType<typeof findMergedPr>>>;
      }> = [];
      for (const worktree of candidates) {
        if (!worktree.branch) continue;
        const pr = await findMergedPr({
          owner: github.owner,
          repo: github.repo,
          headBranch: worktree.branch,
          token: githubToken,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        });
        if (pr) {
          merged.push({ worktree, pr });
        }
      }

      if (merged.length === 0) {
        console.log('No merged worktrees found.');
        return;
      }

      for (const candidate of merged) {
        const isDirty = await hasUncommittedChanges({
          worktreePath: candidate.worktree.path,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        });
        if (isDirty && !options.force) {
          console.log(`Skipping dirty worktree: ${candidate.worktree.path}`);
          continue;
        }

        let shouldRemove = Boolean(options.yes || options.all);
        if (!shouldRemove) {
          shouldRemove = await confirmAction(
            `Remove worktree ${candidate.worktree.path} (PR #${candidate.pr.number})?`,
          );
        }

        if (!shouldRemove) {
          continue;
        }

        await runStep(ctx, 'git.worktree.remove', 'Remove worktree', async () =>
          removeWorktree({
            repoRoot: ctx.repo.repoRoot,
            path: candidate.worktree.path,
            force: Boolean(options.force),
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
          }),
        );
      }
    });
  });

cli
  .command('tree prune', 'Prune stale worktree data')
  .action(async (options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
      await runStep(ctx, 'git.worktree.prune', 'Prune worktrees', async () =>
        pruneWorktrees({
          repoRoot: ctx.repo.repoRoot,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        }),
      );
    });
  });

cli
  .command('tree lock <name>', 'Lock a worktree')
  .option('--reason <reason>', 'Reason for locking')
  .action(async (name: string, options: CliOptions & { reason?: string }) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
      const worktrees = await listWorktrees({
        repoRoot: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
      const target = worktrees.find(
        (worktree) => worktree.branch === name || basename(worktree.path) === name,
      );
      if (!target) {
        throw new Error(`Worktree not found: ${name}`);
      }
      await runStep(ctx, 'git.worktree.lock', 'Lock worktree', async () =>
        lockWorktree({
          repoRoot: ctx.repo.repoRoot,
          path: target.path,
          ...(options.reason ? { reason: options.reason } : {}),
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        }),
      );
    });
  });

cli
  .command('tree unlock <name>', 'Unlock a worktree')
  .action(async (name: string, options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
      const worktrees = await listWorktrees({
        repoRoot: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
      const target = worktrees.find(
        (worktree) => worktree.branch === name || basename(worktree.path) === name,
      );
      if (!target) {
        throw new Error(`Worktree not found: ${name}`);
      }
      await runStep(ctx, 'git.worktree.unlock', 'Unlock worktree', async () =>
        unlockWorktree({
          repoRoot: ctx.repo.repoRoot,
          path: target.path,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        }),
      );
    });
  });

cli
  .command('tree rebase', 'Rebase current branch onto base')
  .action(async (options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
      const ok = await runStep(ctx, 'git.rebase', 'Rebase onto base', async () =>
        rebaseOntoBase({
          repoRoot: ctx.repo.repoRoot,
          baseBranch: ctx.config.repo.defaultBranch,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        }),
      );

      if (!ok) {
        throw new Error('Rebase failed; conflicts were aborted.');
      }
    });
  });

cli
  .command('pr open', 'Open or update a pull request')
  .action(async (options: CliOptions) => {
    await handlePrOpen(options);
  });

cli
  .command('pr sync', 'Sync PR title/body and reviewers')
  .action(async (options: CliOptions) => {
    await handlePrOpen(options);
  });

cli
  .command('ci wait', 'Wait for CI to complete for current branch')
  .option('--interval <ms>', 'Polling interval in ms', { default: '15000' })
  .option('--timeout <ms>', 'Timeout in ms', { default: '900000' })
  .action(async (options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
      const githubToken = requireGitHubAuth(ctx.config);
      const github = await requireGitHubConfig({
        config: ctx.config,
        repoRoot: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
      const { owner, repo } = github;

      const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
      const headBranch = branchResult.stdout.trim();

      const intervalMs = Number(options.interval ?? '15000');
      const timeoutMs = Number(options.timeout ?? '900000');

      const ciResult = await runStep(ctx, 'github.ci.wait', 'Wait for CI', async () =>
        waitForCi({
          owner,
          repo,
          headBranch,
          token: githubToken,
          pollIntervalMs: intervalMs,
          timeoutMs,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        }),
      );

      await persistRunState(ctx, mode, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          ci: ciResult.state,
        },
      }));

      if (github.source === 'origin') {
        await persistRunState(ctx, mode, (data) => ({
          ...data,
          repo: {
            ...(typeof data['repo'] === 'object' && data['repo'] ? data['repo'] : {}),
            github: { owner, repo, source: github.source },
          },
        }));
      }
    });
  });

cli
  .command('review unresolved', 'Fetch unresolved review comments')
  .action(async (options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
      const githubToken = requireGitHubAuth(ctx.config);
      const github = await requireGitHubConfig({
        config: ctx.config,
        repoRoot: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
      const { owner, repo } = github;

      const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
      const headBranch = branchResult.stdout.trim();

      const reviewResult = await runStep(
        ctx,
        'github.review.fetch',
        'Fetch review comments',
        async () =>
          fetchUnresolvedReviewComments({
            owner,
            repo,
            headBranch,
            token: githubToken,
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
          }),
      );

      const now = new Date().toISOString();
      const unresolvedThreadIds = Array.from(
        new Set(reviewResult.comments.map((comment) => comment.threadId)),
      );
      const unresolvedCommentIds = reviewResult.comments.map((comment) => comment.id);
      const unresolvedCommentFingerprints = reviewResult.comments.map((comment) => ({
        id: comment.id,
        threadId: comment.threadId,
        path: comment.path,
        line: comment.line,
        isOutdated: comment.isOutdated,
        bodyHash: hashString(comment.body),
      }));

      await persistRunState(ctx, mode, (data) => ({
        ...data,
        review: {
          pr: reviewResult.pr,
          unresolvedThreadIds,
          unresolvedCommentIds,
          unresolvedCommentFingerprints,
          fetchedAt: now,
        },
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          unresolvedReviewCount: reviewResult.comments.length,
        },
      }));

      if (github.source === 'origin') {
        await persistRunState(ctx, mode, (data) => ({
          ...data,
          repo: {
            ...(typeof data['repo'] === 'object' && data['repo'] ? data['repo'] : {}),
            github: { owner, repo, source: github.source },
          },
        }));
      }
    });
  });

cli.command('run list', 'List all recorded runs').action(async (options: CliOptions) => {
  const repo = await detectRepoContext({ cwd: process.cwd() });
  const configResult = await loadConfig(buildConfigOverrides(options));
  const state = await initStateStore(repo.repoRoot, {
    lock: false,
    mode: configResult.config.state.mode,
    ...(configResult.config.state.root ? { root: configResult.config.state.root } : {}),
  });
  const runEntries = await readdir(state.runsDir);
  const files = runEntries.filter((entry) => entry.endsWith('.json'));
  const runs = [];

  for (const file of files) {
    const runId = file.replace(/\.json$/, '');
    const snapshot = await state.readRunState(runId);
    if (!snapshot) continue;
    const data = snapshot.data as Record<string, unknown>;
    const run = (typeof data['run'] === 'object' && data['run'] ? data['run'] : {}) as {
      status?: string;
      phase?: string;
      step?: string;
      updatedAt?: string;
    };
    const summary = (
      typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}
    ) as { prUrl?: string };

    runs.push({
      runId,
      status: run.status ?? 'unknown',
      phase: run.phase ?? 'unknown',
      step: run.step,
      updatedAt: run.updatedAt,
      prUrl: summary.prUrl,
    });
  }

  runs.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  if (options.json) {
    console.log(JSON.stringify({ runs }, null, 2));
    return;
  }

  for (const run of runs) {
    const parts = [
      run.runId,
      run.status,
      run.phase,
      run.step ?? '-',
      run.updatedAt ?? '-',
      run.prUrl ?? '',
    ].filter((part) => part !== '');
    console.log(parts.join(' | '));
  }
});

cli
  .command('logs <runId>', 'Show audit log for a run')
  .option('--tail <n>', 'Show the last N events')
  .action(async (runId: string, options: CliOptions & { tail?: string }) => {
    const repo = await detectRepoContext({ cwd: process.cwd() });
    const configResult = await loadConfig(buildConfigOverrides(options));
    const state = await initStateStore(repo.repoRoot, {
      lock: false,
      mode: configResult.config.state.mode,
      ...(configResult.config.state.root ? { root: configResult.config.state.root } : {}),
    });
    const logPath = join(state.auditDir, `${runId}.jsonl`);
    const logFile = Bun.file(logPath);
    if (!(await logFile.exists())) {
      throw new SilvanError({
        code: 'audit_log.not_found',
        message: `Audit log not found for run ${runId} (${logPath}).`,
        userMessage: `Audit log not found for run ${runId}.`,
        kind: 'not_found',
        details: { runId, logPath },
        nextSteps: ['Check the run ID with `silvan run list`.'],
      });
    }

    const content = await logFile.text();
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const limit = parseNumberFlag(options.tail);
    const selected = limit ? lines.slice(-limit) : lines;
    const events = selected
      .map((line) => parseAuditEvent(line))
      .filter((event): event is Event => event !== null);

    if (options.json) {
      console.log(JSON.stringify({ runId, events }, null, 2));
      return;
    }

    for (const event of events) {
      console.log(formatAuditEvent(event));
    }
  });

cli
  .command('run inspect <runId>', 'Inspect a run snapshot')
  .action(async (runId: string, options: CliOptions) => {
    const repo = await detectRepoContext({ cwd: process.cwd() });
    const configResult = await loadConfig(buildConfigOverrides(options));
    const state = await initStateStore(repo.repoRoot, {
      lock: false,
      mode: configResult.config.state.mode,
      ...(configResult.config.state.root ? { root: configResult.config.state.root } : {}),
    });
    const snapshot = await state.readRunState(runId);
    if (!snapshot) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    const data = snapshot.data as Record<string, unknown>;
    const task = (
      typeof data['task'] === 'object' && data['task'] ? data['task'] : {}
    ) as {
      id?: string;
      key?: string;
      title?: string;
      provider?: string;
      acceptanceCriteria?: string[];
    };
    const run = (typeof data['run'] === 'object' && data['run'] ? data['run'] : {}) as {
      status?: string;
      phase?: string;
      updatedAt?: string;
    };
    const acCount = Array.isArray(task.acceptanceCriteria)
      ? task.acceptanceCriteria.length
      : 0;

    if (task.id || task.title) {
      console.log(
        `Task: ${task.key ?? task.id ?? 'unknown'} • ${task.title ?? 'Untitled'} • ${task.provider ?? 'unknown'}`,
      );
      console.log(`Acceptance criteria: ${acCount}`);
    }
    console.log(
      `Run: ${snapshot.runId} • ${run.status ?? 'unknown'} • ${run.phase ?? 'unknown'} • ${run.updatedAt ?? 'n/a'}`,
    );
    console.log(`State file: ${snapshot.runId}.json`);
  });

cli
  .command('run status <runId>', 'Show convergence status for a run')
  .action(async (runId: string, options: CliOptions) => {
    const { snapshot } = await loadRunSnapshotForCli(runId, options);
    const convergence = deriveConvergenceFromSnapshot(snapshot);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            runId,
            status: convergence.status,
            reasonCode: convergence.reasonCode,
            message: convergence.message,
            nextActions: convergence.nextActions,
            blockingArtifacts: convergence.blockingArtifacts ?? [],
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`${runId} • ${convergence.status} • ${convergence.reasonCode}`);
    console.log(convergence.message);
    if (convergence.blockingArtifacts?.length) {
      console.log(`Blocking artifacts: ${convergence.blockingArtifacts.join(', ')}`);
    }
    if (convergence.nextActions.length) {
      console.log(`Next actions: ${convergence.nextActions.join(', ')}`);
    }
  });

cli
  .command('run explain <runId>', 'Explain why a run is waiting or blocked')
  .action(async (runId: string, options: CliOptions) => {
    const { snapshot } = await loadRunSnapshotForCli(runId, options);
    const data = snapshot.data as Record<string, unknown>;
    const run = (typeof data['run'] === 'object' && data['run'] ? data['run'] : {}) as {
      status?: string;
      phase?: string;
    };
    const steps = (
      typeof data['steps'] === 'object' && data['steps'] ? data['steps'] : {}
    ) as Record<string, { status?: string; endedAt?: string }>;
    const summary = (
      typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}
    ) as {
      prUrl?: string;
      ci?: string;
      unresolvedReviewCount?: number;
      blockedReason?: string;
    };
    const localGate = (data['localGateSummary'] as
      | { ok?: boolean; blockers?: number; warnings?: number }
      | undefined) ?? { ok: undefined };
    const convergence = deriveConvergenceFromSnapshot(snapshot);
    const lastStep = findLastSuccessfulStep(steps);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            runId,
            run: { status: run.status, phase: run.phase },
            convergence,
            lastSuccessfulStep: lastStep ?? null,
            summaries: {
              ci: summary.ci ?? null,
              unresolvedReviewCount: summary.unresolvedReviewCount ?? null,
              blockedReason: summary.blockedReason ?? null,
              localGate,
            },
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(`${runId} • ${run.status ?? 'unknown'} • ${run.phase ?? 'unknown'}`);
    console.log(`Convergence: ${convergence.status} • ${convergence.reasonCode}`);
    console.log(convergence.message);
    if (lastStep) {
      console.log(`Last successful step: ${lastStep}`);
    }
    if (summary.prUrl) {
      console.log(`PR: ${summary.prUrl}`);
    }
    if (summary.ci) {
      console.log(`CI: ${summary.ci}`);
    }
    if (typeof summary.unresolvedReviewCount === 'number') {
      console.log(`Unresolved review comments: ${summary.unresolvedReviewCount}`);
    }
    if (summary.blockedReason) {
      console.log(`Blocked reason: ${summary.blockedReason}`);
    }
    if (localGate.ok === false) {
      console.log(
        `Local gate: ${localGate.blockers ?? 0} blockers, ${localGate.warnings ?? 0} warnings`,
      );
    }
    if (convergence.blockingArtifacts?.length) {
      console.log(`Blocking artifacts: ${convergence.blockingArtifacts.join(', ')}`);
    }
    if (convergence.nextActions.length) {
      console.log(`Next actions: ${convergence.nextActions.join(', ')}`);
    }
  });

cli
  .command('learning show <runId>', 'Show learning notes for a run')
  .action(async (runId: string, options: CliOptions) => {
    const { snapshot } = await loadRunSnapshotForCli(runId, options);
    const data = snapshot.data as Record<string, unknown>;
    const artifactsIndex =
      typeof data['artifactsIndex'] === 'object' && data['artifactsIndex']
        ? (data['artifactsIndex'] as Record<string, Record<string, unknown>>)
        : undefined;
    const notesEntry =
      artifactsIndex?.['learning.notes']?.['notes'] ??
      artifactsIndex?.['learning.notes']?.['data'];
    if (!notesEntry || typeof notesEntry !== 'object') {
      throw new Error('Learning notes not found for this run.');
    }
    if (!isArtifactEntry(notesEntry)) {
      throw new Error('Learning notes artifact entry is invalid.');
    }
    const content = await readArtifact({ entry: notesEntry });
    if (options.json) {
      console.log(JSON.stringify(content, null, 2));
      return;
    }
    if (notesEntry.kind === 'text') {
      console.log(content);
      return;
    }
    console.log(JSON.stringify(content, null, 2));
  });

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

cli
  .command('run resume <runId>', 'Resume a run using convergence rules')
  .option('--dry-run', 'Allow only read-only tools')
  .option('--apply', 'Allow mutating tools')
  .option('--dangerous', 'Allow dangerous tools (requires --apply)')
  .action(async (runId: string, options: CliOptions) => {
    const { snapshot } = await loadRunSnapshotForCli(runId, options);
    const convergence = deriveConvergenceFromSnapshot(snapshot);
    if (convergence.status === 'converged' || convergence.status === 'aborted') {
      console.log(
        `Run ${runId} is ${convergence.status}; resume is not applicable (${convergence.reasonCode}).`,
      );
      return;
    }
    await withCliContext(
      options,
      'headless',
      async (ctx) =>
        withAgentSessions(Boolean(ctx.config.ai.sessions.persist), async (sessions) => {
          const runOptions = {
            ...(options.dryRun ? { dryRun: true } : {}),
            ...(options.apply ? { apply: true } : {}),
            ...(options.dangerous ? { dangerous: true } : {}),
            sessions,
          };
          await resumeRun(ctx, runOptions);
        }),
      { runId },
    );
  });

cli
  .command('run override <runId> <reason...>', 'Override a run gate with a reason')
  .action(async (runId: string, reason: string[], options: CliOptions) => {
    const message = reason.join(' ').trim();
    if (!message) {
      throw new Error('Override reason is required.');
    }
    const { state } = await loadRunSnapshotForCli(runId, options);
    const entry = await writeOverrideArtifact({ state, runId, reason: message });
    if (options.json) {
      console.log(JSON.stringify({ runId, override: entry }, null, 2));
      return;
    }
    console.log(`Override recorded for ${runId}: ${entry.path}`);
  });

cli
  .command('run abort <runId> [reason]', 'Abort a run and mark it as canceled')
  .action(async (runId: string, reason: string | undefined, options: CliOptions) => {
    const { state } = await loadRunSnapshotForCli(runId, options);
    const entry = await markRunAborted({ state, runId, ...(reason ? { reason } : {}) });
    if (options.json) {
      console.log(JSON.stringify({ runId, aborted: entry }, null, 2));
      return;
    }
    console.log(`Run ${runId} marked as aborted.`);
  });

cli.command('ui', 'Launch the Ink dashboard').action(async (options: CliOptions) => {
  if (options.noUi) {
    throw new Error('The --no-ui flag cannot be used with silvan ui.');
  }
  await withCliContext(
    options,
    'ui',
    async (ctx) => {
      let stopPolling = () => {};
      try {
        const githubToken = requireGitHubAuth(ctx.config);
        const github = await requireGitHubConfig({
          config: ctx.config,
          repoRoot: ctx.repo.repoRoot,
          bus: ctx.events.bus,
          context: {
            runId: ctx.runId,
            repoRoot: ctx.repo.repoRoot,
            mode: ctx.events.mode,
          },
        });
        stopPolling = startPrSnapshotPoller({
          owner: github.owner,
          repo: github.repo,
          token: githubToken,
          bus: ctx.events.bus,
          context: {
            runId: ctx.runId,
            repoRoot: ctx.repo.repoRoot,
            mode: ctx.events.mode,
          },
        });
      } catch {
        stopPolling = () => {};
      }

      try {
        await mountDashboard(ctx.events.bus, ctx.state);
      } finally {
        stopPolling();
      }
    },
    { lock: false },
  );
});

cli
  .command(
    'task start [taskRef]',
    'Start a task (accepts: Linear ID like "ENG-123", GitHub issue like "gh-42" or URL, or local title)',
  )
  .option('--title <title>', 'Task title for local tasks')
  .option('--desc <desc>', 'Task description for local tasks')
  .option('--ac <criteria>', 'Acceptance criteria (can be used multiple times)')
  .option('--from-file <path>', 'Load task details from a markdown file')
  .option('--print-cd', 'Print cd command to worktree (default: true)', {
    default: true,
  })
  .option('--open-shell', 'Open interactive shell in worktree')
  .option('--exec <cmd>', 'Run command in worktree then exit')
  .action((taskRef: string | undefined, options: CliOptions) =>
    withCliContext(options, 'headless', async (ctx) =>
      withAgentSessions(Boolean(ctx.config.ai.sessions.persist), async (sessions) => {
        let localInput = await buildLocalTaskInput(options);
        let inferred =
          taskRef ??
          inferTaskRefFromBranch(ctx.repo.branch ?? '') ??
          localInput?.title ??
          '';

        if (!inferred) {
          if (!process.stdin.isTTY) {
            throw new Error(
              'Task reference required. Provide a Linear ID, gh-<number>, GitHub issue URL, or a local title.',
            );
          }
          localInput = await promptLocalTaskInput();
          inferred = localInput.title;
        }
        await startTaskFlow({
          ctx,
          ...(sessions ? { sessions } : {}),
          taskRef: inferred,
          ...(localInput ? { localInput } : {}),
          printCd: options.printCd !== false,
          ...(options.exec ? { exec: options.exec } : {}),
          ...(options.openShell ? { openShell: options.openShell } : {}),
        });
      }),
    ),
  );

cli.command('queue run', 'Process queued task requests').action((options: CliOptions) =>
  withCliContext(options, 'headless', async (ctx) => {
    const logger = createCliLogger(ctx);
    const requests = await listQueueRequests({ state: ctx.state });
    if (requests.length === 0) {
      await logger.info('No queued requests.');
      return;
    }

    for (const request of requests) {
      await withRunContext(
        {
          cwd: process.cwd(),
          mode: 'headless',
          lock: true,
          configOverrides: buildConfigOverrides(options),
        },
        async (runCtx) =>
          withAgentSessions(
            Boolean(runCtx.config.ai.sessions.persist),
            async (sessions) => {
              const localInput: LocalTaskInput = {
                title: request.title,
                ...(request.description ? { description: request.description } : {}),
                ...(request.acceptanceCriteria?.length
                  ? { acceptanceCriteria: request.acceptanceCriteria }
                  : {}),
              };
              await startTaskFlow({
                ctx: runCtx,
                ...(sessions ? { sessions } : {}),
                taskRef: request.title,
                localInput,
                printCd: false,
              });
            },
          ),
      );

      await deleteQueueRequest({ state: ctx.state, requestId: request.id });
    }
  }),
);

async function buildLocalTaskInput(
  options: CliOptions,
): Promise<LocalTaskInput | undefined> {
  const acValues = Array.isArray(options.ac)
    ? options.ac
    : options.ac
      ? [options.ac]
      : [];
  const fromFile = options.fromFile?.trim();
  let input: LocalTaskInput | undefined;

  if (fromFile) {
    const contents = await Bun.file(fromFile).text();
    input = parseLocalTaskFile(contents);
  }

  if (!input && !options.title && !options.desc && acValues.length === 0) {
    return undefined;
  }

  const merged: LocalTaskInput = {
    title: options.title ?? input?.title ?? '',
    ...(options.desc
      ? { description: options.desc }
      : input?.description
        ? { description: input.description }
        : {}),
    ...(acValues.length > 0
      ? { acceptanceCriteria: acValues }
      : input?.acceptanceCriteria
        ? { acceptanceCriteria: input.acceptanceCriteria }
        : {}),
  };

  return merged;
}

async function startTaskFlow(options: {
  ctx: RunContext;
  sessions?: ReturnType<typeof createSessionPool>;
  taskRef: string;
  localInput?: LocalTaskInput;
  printCd: boolean;
  exec?: string;
  openShell?: boolean;
}): Promise<void> {
  const ctx = options.ctx;
  const mode = ctx.events.mode;
  let logger = createCliLogger(ctx);
  const resolved = await logger.withSpan(
    'Resolve task',
    () =>
      resolveTask(options.taskRef, {
        config: ctx.config,
        repoRoot: ctx.repo.repoRoot,
        state: ctx.state,
        runId: ctx.runId,
        ...(options.localInput ? { localInput: options.localInput } : {}),
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      }),
    { taskRef: options.taskRef },
  );

  await logger.info(
    `Task: ${resolved.task.key ?? resolved.task.id} • ${resolved.task.title} • ${resolved.task.provider}`,
  );

  const safeName = buildWorktreeName(resolved.task);
  const worktree = await runStep(
    ctx,
    'git.worktree.create',
    'Create worktree',
    async () =>
      createWorktree({
        repoRoot: ctx.repo.repoRoot,
        name: safeName,
        config: ctx.config,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      }),
  );

  ctx.repo.worktreePath = worktree.path;
  if (worktree.branch) {
    ctx.repo.branch = worktree.branch;
  }
  ctx.repo.isWorktree = true;
  logger = createCliLogger(ctx);

  await normalizeClaudeSettings({ worktreePath: worktree.path });

  const installResult = await logger.withSpan(
    'Install dependencies',
    () => installDependencies({ worktreePath: worktree.path }),
    { worktreePath: worktree.path },
  );
  if (!installResult.ok) {
    await logger.warn(`Warning: bun install failed in ${worktree.path}`, {
      stderr: installResult.stderr,
      stdout: installResult.stdout,
    });
  }

  await runPlanner(ctx, {
    taskRef: resolved.ref.raw,
    task: resolved.task,
    worktreeName: safeName,
    ...(options.sessions ? { sessions: options.sessions } : {}),
  });

  if (options.printCd) {
    await logger.info(`cd ${worktree.path}`);
  }
  if (options.exec) {
    runCommandInWorktree(options.exec, worktree.path);
  }
  if (options.openShell) {
    openShellInWorktree(worktree.path);
  }
}

function runCommandInWorktree(command: string, worktreePath: string): void {
  if (!command.trim()) return;
  const result = spawnSync(command, {
    cwd: worktreePath,
    stdio: 'inherit',
    shell: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exitCode = result.status;
  }
}

function openShellInWorktree(worktreePath: string): void {
  if (!process.stdin.isTTY) {
    throw new Error('Cannot open a shell without a TTY.');
  }
  const shell =
    process.platform === 'win32'
      ? (process.env['COMSPEC'] ?? 'powershell.exe')
      : (process.env['SHELL'] ?? '/bin/sh');
  const result = spawnSync(shell, {
    cwd: worktreePath,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw result.error;
  }
}

async function loadRunSnapshotForCli(
  runId: string,
  options: CliOptions,
): Promise<{
  state: Awaited<ReturnType<typeof initStateStore>>;
  snapshot: Awaited<ReturnType<typeof loadRunSnapshot>>;
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
}> {
  const repo = await detectRepoContext({ cwd: process.cwd() });
  const configResult = await loadConfig(buildConfigOverrides(options));
  const state = await initStateStore(repo.repoRoot, {
    lock: false,
    mode: configResult.config.state.mode,
    ...(configResult.config.state.root ? { root: configResult.config.state.root } : {}),
  });
  const snapshot = await loadRunSnapshot(state, runId);
  return { state, snapshot, config: configResult.config };
}

function parseAuditEvent(line: string): Event | null {
  try {
    return JSON.parse(line) as Event;
  } catch {
    return null;
  }
}

function formatAuditEvent(event: Event): string {
  const base = `${event.ts} [${event.level}] ${event.source} ${event.type}`;
  const message =
    event.message ?? (event.type === 'log.message' ? event.payload.message : undefined);
  if (message) {
    return `${base} - ${message}`;
  }
  if (event.error?.message) {
    return `${base} - ${event.error.message}`;
  }
  if (event.type === 'run.step') {
    return `${base} - ${event.payload.status}: ${event.payload.title}`;
  }
  if (event.type === 'run.finished') {
    return `${base} - ${event.payload.status} (${event.payload.durationMs}ms)`;
  }
  return base;
}

function findLastSuccessfulStep(
  steps: Record<string, { status?: string; endedAt?: string }>,
) {
  return Object.entries(steps)
    .filter(([, step]) => step?.status === 'done')
    .sort((a, b) => (b[1]?.endedAt ?? '').localeCompare(a[1]?.endedAt ?? ''))[0]?.[0];
}

cli
  .command('agent plan', 'Generate plan')
  .option('--task <task>', 'Task reference (Linear ID, gh-<number>, or URL)')
  .action((options: CliOptions) =>
    withCliContext(options, 'headless', async (ctx) =>
      withAgentSessions(Boolean(ctx.config.ai.sessions.persist), (sessions) =>
        runPlanner(ctx, {
          ...(options.task ? { taskRef: options.task } : {}),
          sessions,
        }),
      ),
    ),
  );

cli
  .command('agent clarify', 'Answer plan questions')
  .option('--answer <pair>', 'Answer question (id=value)', { default: [] })
  .action((options: CliOptions & { answer?: string | string[] }) =>
    withCliContext(options, 'headless', async (ctx) =>
      withAgentSessions(Boolean(ctx.config.ai.sessions.persist), async (sessions) => {
        const logger = createCliLogger(ctx);
        const state = await ctx.state.readRunState(ctx.runId);
        const data = (state?.data as Record<string, unknown>) ?? {};
        const plan = data['plan'];
        if (!plan || typeof plan !== 'object') {
          throw new Error('No plan found in run state. Run agent plan first.');
        }

        const questions = Array.isArray((plan as { questions?: unknown }).questions)
          ? ((
              plan as {
                questions?: Array<{ id: string; text: string; required?: boolean }>;
              }
            ).questions ?? [])
          : [];

        if (questions.length === 0) {
          await logger.info('No clarifications needed.');
          return;
        }

        const provided = parseAnswerPairs(options.answer);
        const clarifications = await collectClarifications({
          questions,
          answers: {
            ...(typeof data['clarifications'] === 'object' && data['clarifications']
              ? (data['clarifications'] as Record<string, string>)
              : {}),
            ...provided,
          },
        });

        const missingRequired = questions.filter(
          (question) => question.required !== false && !clarifications[question.id],
        );
        if (missingRequired.length > 0) {
          const ids = missingRequired.map((question) => question.id).join(', ');
          throw new Error(`Missing required clarifications: ${ids}`);
        }

        await persistRunState(ctx, ctx.events.mode, (data) => ({
          ...data,
          clarifications,
        }));

        const task = data['task'];
        const taskRef =
          typeof data['taskRef'] === 'object' && data['taskRef']
            ? (data['taskRef'] as { raw?: string }).raw
            : undefined;
        const taskId =
          typeof task === 'object' && task && 'id' in task
            ? (task as { id?: string }).id
            : undefined;

        await runPlanner(ctx, {
          ...(taskRef ? { taskRef } : taskId ? { taskRef: taskId } : {}),
          clarifications,
          sessions,
        });
      }),
    ),
  );

cli
  .command('agent run', 'Execute the implementation plan')
  .option('--dry-run', 'Read-only mode: no file changes (default)')
  .option('--apply', 'Allow file modifications (edits, writes, deletes)')
  .option('--dangerous', 'Allow shell commands and network access (requires --apply)')
  .action((options: CliOptions) =>
    withCliContext(options, 'headless', async (ctx) =>
      withAgentSessions(Boolean(ctx.config.ai.sessions.persist), async (sessions) => {
        const runOptions = {
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(options.apply ? { apply: true } : {}),
          ...(options.dangerous ? { dangerous: true } : {}),
          sessions,
        };
        const shouldReview = await runImplementation(ctx, runOptions);
        if (shouldReview) {
          await runReviewLoop(ctx, runOptions);
        }
      }),
    ),
  );

cli
  .command('agent resume', 'Resume agent')
  .action((options: CliOptions) =>
    withCliContext(options, 'headless', async (ctx) =>
      withAgentSessions(Boolean(ctx.config.ai.sessions.persist), () => runRecovery(ctx)),
    ),
  );

// Shell completion
cli
  .command('completion <shell>', 'Generate shell completion script (bash, zsh, fish)')
  .action((shell: string) => {
    switch (shell.toLowerCase()) {
      case 'bash':
        console.log(generateBashCompletion());
        console.log('# Add to ~/.bashrc: eval "$(silvan completion bash)"');
        break;
      case 'zsh':
        console.log(generateZshCompletion());
        console.log('# Add to ~/.zshrc: eval "$(silvan completion zsh)"');
        break;
      case 'fish':
        console.log(generateFishCompletion());
        console.log('# Save to ~/.config/fish/completions/silvan.fish');
        break;
      default:
        throw new Error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
    }
  });

// Config inspection commands
cli
  .command('config show', 'Display resolved configuration')
  .action(async (options: CliOptions) => {
    const { config, source } = await loadConfig(buildConfigOverrides(options));
    if (options.json) {
      console.log(JSON.stringify({ source, config }, null, 2));
      return;
    }
    console.log(`Config source: ${source?.path ?? 'defaults (no config file found)'}`);
    console.log('');
    console.log('Key settings:');
    console.log(`  Default branch: ${config.repo.defaultBranch}`);
    console.log(`  Branch prefix: ${config.naming.branchPrefix}`);
    console.log(`  Worktree dir: ${config.naming.worktreeDir}`);
    console.log(`  State mode: ${config.state.mode}`);
    console.log('');
    console.log('AI settings:');
    console.log(`  Default model: ${config.ai.models.default}`);
    console.log(`  Max turns: ${config.ai.budgets.default.maxTurns}`);
    if (config.ai.budgets.default.maxBudgetUsd) {
      console.log(`  Max budget: $${config.ai.budgets.default.maxBudgetUsd}`);
    }
    console.log('');
    console.log('Task providers:');
    console.log(`  Enabled: ${config.task.providers.enabled.join(', ') || 'none'}`);
    console.log('');
    console.log('Verify commands:');
    if (config.verify.commands.length === 0) {
      console.log('  (none configured)');
    } else {
      for (const cmd of config.verify.commands) {
        console.log(`  ${cmd.name}: ${cmd.cmd}`);
      }
    }
    console.log('');
    console.log('Use --json for full configuration output.');
  });

cli
  .command('config validate', 'Validate configuration without running')
  .action(async (options: CliOptions) => {
    try {
      const { config, source } = await loadConfig(buildConfigOverrides(options));
      const checks: Array<{ name: string; ok: boolean; message: string }> = [];

      // Check config loaded
      checks.push({
        name: 'Config file',
        ok: true,
        message: source ? `Loaded from ${source.path}` : 'Using defaults',
      });

      // Check GitHub auth
      const hasGitHubToken = Boolean(
        config.github.token || process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'],
      );
      checks.push({
        name: 'GitHub token',
        ok: hasGitHubToken,
        message: hasGitHubToken
          ? 'Found'
          : 'Missing (set GITHUB_TOKEN or configure github.token)',
      });

      // Check Linear auth if enabled
      if (config.task.providers.enabled.includes('linear')) {
        const hasLinearToken = Boolean(
          config.linear.token || process.env['LINEAR_API_KEY'],
        );
        checks.push({
          name: 'Linear token',
          ok: hasLinearToken,
          message: hasLinearToken
            ? 'Found'
            : 'Missing (set LINEAR_API_KEY or configure linear.token)',
        });
      }

      // Check verify commands
      const hasVerifyCommands = config.verify.commands.length > 0;
      checks.push({
        name: 'Verify commands',
        ok: hasVerifyCommands,
        message: hasVerifyCommands
          ? `${config.verify.commands.length} command(s) configured`
          : 'None configured (runs will skip verification)',
      });

      if (options.json) {
        const allOk = checks.every((c) => c.ok);
        console.log(JSON.stringify({ ok: allOk, checks }, null, 2));
        if (!allOk) process.exitCode = 1;
        return;
      }

      for (const check of checks) {
        const prefix = check.ok ? 'ok' : 'warn';
        console.log(`${prefix}  ${check.name}: ${check.message}`);
      }

      const allOk = checks.every((c) => c.ok);
      if (!allOk) {
        console.log('');
        console.log('Some checks have warnings. Fix them for full functionality.');
        process.exitCode = 1;
      } else {
        console.log('');
        console.log('Configuration is valid.');
      }
    } catch (error) {
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );
      } else {
        console.error(
          `Configuration error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      process.exitCode = 1;
    }
  });

cli
  .command('doctor', 'Check environment and configuration')
  .option('--network', 'Check network connectivity to providers')
  .action(async (options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
      const report = await collectDoctorReport(ctx, {
        network: Boolean(options.network),
      });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        for (const check of report.checks) {
          const prefix = check.ok ? 'ok' : 'fail';
          console.log(`${prefix} ${check.name} ${check.detail}`);
        }
      }
      if (!report.ok) {
        process.exitCode = 1;
      }
    });
  });

cli
  .command('convo show <runId>', 'Show conversation context')
  .option('--limit <limit>', 'Number of messages to show', { default: '20' })
  .action((runId: string, options: CliOptions & { limit?: string }) =>
    withCliContext(options, 'headless', async (ctx) => {
      const snapshot = await loadConversationSnapshot(ctx.state, runId);
      if (!snapshot) {
        throw new Error(`No conversation found for run ${runId}`);
      }
      const limit = Math.max(1, Number(options.limit ?? 20) || 20);
      const summary = summarizeConversationSnapshot(snapshot, { limit });
      console.log(renderConversationSummary(summary));
    }),
  );

cli
  .command('convo export <runId>', 'Export conversation snapshot')
  .option('--format <format>', 'json or md', { default: 'json' })
  .action((runId: string, options: CliOptions & { format?: string }) =>
    withCliContext(options, 'headless', async (ctx) => {
      const snapshot = await loadConversationSnapshot(ctx.state, runId);
      if (!snapshot) {
        throw new Error(`No conversation found for run ${runId}`);
      }
      const format = (options.format ?? 'json') as 'json' | 'md';
      if (format !== 'json' && format !== 'md') {
        throw new Error('Format must be json or md');
      }
      console.log(exportConversationSnapshot(snapshot, { format }));
    }),
  );

// Command aliases: short names for common commands
const COMMAND_ALIASES: Record<string, string> = {
  t: 'tree',
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

export async function run(argv: string[]): Promise<void> {
  const debugEnabled = argv.includes('--debug') || argv.includes('--trace');
  if (debugEnabled) {
    process.env['SILVAN_DEBUG'] = '1';
  }

  // Step 1: Expand command aliases (t -> tree, r -> run, etc.)
  const expandedArgv = expandAliases(argv);

  // Step 2: Combine multi-word commands into single args for cac matching
  // e.g., ["task", "start", "DEP-159"] -> ["task start", "DEP-159"]
  const processedArgv = combineMultiWordCommand(expandedArgv);

  // Step 3: Parse with cac
  cli.parse(processedArgv, { run: false });

  // Step 4: Run the matched command
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- cac's return type is untyped.
  const runPromise: Promise<unknown> | undefined = cli.runMatchedCommand();

  // runMatchedCommand returns undefined when no command matches (e.g., --help)
  if (runPromise instanceof Promise) {
    try {
      await runPromise;
    } catch (error) {
      const debugEnabled = argv.includes('--debug') || argv.includes('--trace');
      const traceEnabled = argv.includes('--trace');
      const rendered = renderCliError(error, {
        debug: debugEnabled,
        trace: traceEnabled,
      });
      console.error(rendered.message);
      if (rendered.error.exitCode !== undefined) {
        process.exitCode = rendered.error.exitCode;
      } else if (process.exitCode === undefined) {
        process.exitCode = 1;
      }
    }
  }
}

async function handlePrOpen(options: CliOptions): Promise<void> {
  const mode: EventMode = options.json ? 'json' : 'headless';
  await withCliContext(options, mode, async (ctx) => {
    const githubToken = requireGitHubAuth(ctx.config);
    const github = await requireGitHubConfig({
      config: ctx.config,
      repoRoot: ctx.repo.repoRoot,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
    });
    const { owner, repo } = github;

    const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ctx.repo.repoRoot,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
    });
    const headBranch = branchResult.stdout.trim();
    const baseBranch = ctx.config.github.baseBranch ?? ctx.config.repo.defaultBranch;
    const title = headBranch;
    const body = `Automated PR for ${headBranch}.`;

    const prResult = await runStep(ctx, 'github.pr.open', 'Open or update PR', async () =>
      openOrUpdatePr({
        owner,
        repo,
        headBranch,
        baseBranch,
        title,
        body,
        token: githubToken,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      }),
    );

    await runStep(ctx, 'github.review.request', 'Request reviewers', async () =>
      requestReviewers({
        pr: prResult.pr,
        reviewers: ctx.config.github.reviewers,
        requestCopilot: ctx.config.github.requestCopilot,
        token: githubToken,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      }),
    );

    await persistRunState(ctx, mode, (data) => ({
      ...data,
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary']
          ? data['summary']
          : {}),
        prUrl: prResult.pr.url,
      },
    }));

    if (github.source === 'origin') {
      await persistRunState(ctx, mode, (data) => ({
        ...data,
        repo: {
          ...(typeof data['repo'] === 'object' && data['repo'] ? data['repo'] : {}),
          github: { owner, repo, source: github.source },
        },
      }));
    }
  });
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

function buildEmitContext(ctx: RunContext): EmitContext {
  return {
    runId: ctx.runId,
    repoRoot: ctx.repo.repoRoot,
    mode: ctx.events.mode,
    ...(ctx.repo.worktreePath ? { worktreePath: ctx.repo.worktreePath } : {}),
  };
}

function createCliLogger(ctx: RunContext) {
  return createLogger({
    bus: ctx.events.bus,
    source: 'cli',
    context: buildEmitContext(ctx),
  });
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

function parseAnswerPairs(raw: string | string[] | undefined): Record<string, string> {
  if (!raw) return {};
  const entries = Array.isArray(raw) ? raw : [raw];
  const answers: Record<string, string> = {};
  for (const entry of entries) {
    const [id, ...rest] = entry.split('=');
    const value = rest.join('=').trim();
    if (!id || !value) continue;
    answers[id.trim()] = value;
  }
  return answers;
}
