import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { cac } from 'cac';

import { collectClarifications } from '../agent/clarify';
import { createSessionPool } from '../agent/session';
import { loadConfig } from '../config/load';
import type { Config, ConfigInput } from '../config/schema';
import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import type { RunContext } from '../core/context';
import { withRunContext } from '../core/context';
import { detectRepoContext } from '../core/repo';
import {
  resumeRun,
  runImplementation,
  runPlanner,
  runRecovery,
  runReviewLoop,
} from '../core/run-controller';
import { createEnvelope } from '../events/emit';
import type { EventMode, RunStep } from '../events/schema';
import { runGit } from '../git/exec';
import {
  createWorktree,
  ensureArtifactsIgnored,
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
import { initStateStore } from '../state/store';
import { inferTaskRefFromBranch, resolveTask } from '../task/resolve';
import { mountDashboard, startPrSnapshotPoller } from '../ui';
import { confirmAction } from '../utils/confirm';
import { hashString } from '../utils/hash';
import { sanitizeName } from '../utils/slug';

const cli = cac('silvan');

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
};

cli.option('--json', 'Output JSON event stream');
cli.option('--no-ui', 'Disable UI');
cli.option('--yes', 'Skip confirmations');
cli.option('--github-token <token>', 'GitHub token (overrides config/env)');
cli.option('--linear-token <token>', 'Linear token (overrides config/env)');
cli.option('--model <model>', 'Default Claude model');
cli.option('--model-plan <model>', 'Planner model');
cli.option('--model-execute <model>', 'Executor model');
cli.option('--model-review <model>', 'Review model');
cli.option('--model-verify <model>', 'Verify model');
cli.option('--model-pr <model>', 'PR writer model');
cli.option('--model-recovery <model>', 'Recovery model');
cli.option('--max-turns <n>', 'Max turns per session');
cli.option('--max-turns-plan <n>', 'Max turns for planner');
cli.option('--max-turns-execute <n>', 'Max turns for executor');
cli.option('--max-turns-review <n>', 'Max turns for review');
cli.option('--max-turns-verify <n>', 'Max turns for verify');
cli.option('--max-turns-pr <n>', 'Max turns for PR writer');
cli.option('--max-turns-recovery <n>', 'Max turns for recovery');
cli.option('--max-budget-usd <n>', 'Max budget in USD per session');
cli.option('--max-budget-usd-plan <n>', 'Max USD budget for planner');
cli.option('--max-budget-usd-execute <n>', 'Max USD budget for executor');
cli.option('--max-budget-usd-review <n>', 'Max USD budget for review');
cli.option('--max-budget-usd-verify <n>', 'Max USD budget for verify');
cli.option('--max-budget-usd-pr <n>', 'Max USD budget for PR writer');
cli.option('--max-budget-usd-recovery <n>', 'Max USD budget for recovery');
cli.option('--max-thinking-tokens <n>', 'Max thinking tokens per session');
cli.option('--max-thinking-tokens-plan <n>', 'Max thinking tokens for planner');
cli.option('--max-thinking-tokens-execute <n>', 'Max thinking tokens for executor');
cli.option('--max-thinking-tokens-review <n>', 'Max thinking tokens for review');
cli.option('--max-thinking-tokens-verify <n>', 'Max thinking tokens for verify');
cli.option('--max-thinking-tokens-pr <n>', 'Max thinking tokens for PR writer');
cli.option('--max-thinking-tokens-recovery <n>', 'Max thinking tokens for recovery');
cli.option('--max-tool-calls <n>', 'Max tool calls per session');
cli.option('--max-tool-ms <n>', 'Max tool call duration (ms)');
cli.option('--max-review-loops <n>', 'Max review loop iterations');
cli.option('--persist-sessions', 'Persist agent sessions across phases');
cli.option('--verify-shell <path>', 'Shell used for verify commands');
cli.option('--state-mode <mode>', 'Use repo or global state storage');

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

cli.command('wt list', 'List worktrees').action(async (options: CliOptions) => {
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
  .command('wt add <name>', 'Create a worktree and branch')
  .action(async (name: string, options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
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
      await ensureArtifactsIgnored({
        worktreePath: worktree.path,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });

      const installResult = await installDependencies({ worktreePath: worktree.path });
      if (!installResult.ok) {
        console.warn(
          `Warning: bun install failed in ${worktree.path}\n${installResult.stderr || installResult.stdout}`,
        );
      }
    });
  });

cli
  .command('wt remove [name]', 'Remove a worktree')
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
  .command('wt clean', 'Remove worktrees with merged PRs')
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
  .command('wt prune', 'Prune stale worktree data')
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
  .command('wt lock <name>', 'Lock a worktree')
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
  .command('wt unlock <name>', 'Unlock a worktree')
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
  .command('wt rebase', 'Rebase current branch onto base')
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

cli.command('runs list', 'List recorded runs').action(async (options: CliOptions) => {
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
  .command('runs inspect <runId>', 'Inspect a run snapshot')
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
    console.log(JSON.stringify(snapshot, null, 2));
  });

cli
  .command('runs resume <runId>', 'Resume a run from state')
  .option('--dry-run', 'Allow only read-only tools')
  .option('--apply', 'Allow mutating tools')
  .option('--dangerous', 'Allow dangerous tools (requires --apply)')
  .action((runId: string, options: CliOptions) =>
    withCliContext(
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
    ),
  );

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
  .command('task start [taskRef]', 'Start a task')
  .action((taskRef: string | undefined, options: CliOptions) =>
    withCliContext(options, 'headless', async (ctx) =>
      withAgentSessions(Boolean(ctx.config.ai.sessions.persist), async (sessions) => {
        const mode = ctx.events.mode;
        const inferred = taskRef ?? inferTaskRefFromBranch(ctx.repo.branch ?? '');

        if (!inferred) {
          throw new Error(
            'Task reference required. Provide a Linear ID, gh-<number>, or GitHub issue URL.',
          );
        }

        const resolved = await resolveTask(inferred, {
          config: ctx.config,
          repoRoot: ctx.repo.repoRoot,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        });

        console.log(
          `Task: ${resolved.task.id} • ${resolved.task.title} • ${resolved.task.provider}`,
        );

        const safeName = sanitizeName(resolved.task.id);
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
        await ensureArtifactsIgnored({
          worktreePath: worktree.path,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        });

        const installResult = await installDependencies({ worktreePath: worktree.path });
        if (!installResult.ok) {
          console.warn(
            `Warning: bun install failed in ${worktree.path}\n${installResult.stderr || installResult.stdout}`,
          );
        }

        await runPlanner(ctx, {
          taskRef: resolved.ref.raw,
          task: resolved.task,
          worktreeName: safeName,
          sessions,
        });
      }),
    ),
  );

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
          console.log('No clarifications needed.');
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
  .command('agent run', 'Run agent')
  .option('--dry-run', 'Allow only read-only tools')
  .option('--apply', 'Allow mutating tools')
  .option('--dangerous', 'Allow dangerous tools (requires --apply)')
  .action((options: CliOptions) =>
    withCliContext(options, 'headless', async (ctx) =>
      withAgentSessions(Boolean(ctx.config.ai.sessions.persist), async (sessions) => {
        const runOptions = {
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(options.apply ? { apply: true } : {}),
          ...(options.dangerous ? { dangerous: true } : {}),
          sessions,
        };
        await runImplementation(ctx, runOptions);
        await runReviewLoop(ctx, runOptions);
      }),
    ),
  );

cli
  .command('agent resume', 'Resume agent')
  .action((options: CliOptions) =>
    withCliContext(options, 'headless', async (ctx) =>
      withAgentSessions(Boolean(ctx.config.ai.sessions.persist), (sessions) =>
        runRecovery(ctx, { sessions }),
      ),
    ),
  );

cli
  .command('doctor', 'Check environment and configuration')
  .action(async (options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withCliContext(options, mode, async (ctx) => {
      const results: Array<{ name: string; ok: boolean; detail: string }> = [];

      const gitVersion = await runGit(['--version'], {
        cwd: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
      results.push({
        name: 'git.version',
        ok: gitVersion.exitCode === 0,
        detail: gitVersion.stdout.trim() || gitVersion.stderr.trim(),
      });

      try {
        const github = await requireGitHubConfig({
          config: ctx.config,
          repoRoot: ctx.repo.repoRoot,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        });
        results.push({
          name: 'github.remote',
          ok: true,
          detail: `${github.owner}/${github.repo} (${github.source})`,
        });
      } catch (error) {
        results.push({
          name: 'github.remote',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      if (ctx.config.task.providers.enabled.includes('github')) {
        const ghTokenPresent = Boolean(ctx.config.github.token);
        results.push({
          name: 'github.token',
          ok: ghTokenPresent,
          detail: ghTokenPresent ? 'Found' : 'Missing github.token',
        });
      }

      if (ctx.config.task.providers.enabled.includes('linear')) {
        const linearTokenPresent = Boolean(ctx.config.linear.token);
        results.push({
          name: 'linear.token',
          ok: linearTokenPresent,
          detail: linearTokenPresent ? 'Found' : 'Missing linear.token',
        });
      }

      const verifyConfigured = ctx.config.verify.commands.length > 0;
      results.push({
        name: 'verify.commands',
        ok: verifyConfigured,
        detail: verifyConfigured
          ? `${ctx.config.verify.commands.length} command(s)`
          : 'No verification commands configured',
      });

      for (const result of results) {
        const prefix = result.ok ? 'ok' : 'fail';
        console.log(`${prefix} ${result.name} ${result.detail}`);
      }
    });
  });

export function run(argv: string[]): void {
  cli.parse(argv, { run: false });
  const runPromise = cli.runMatchedCommand() as Promise<void>;
  runPromise.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
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
