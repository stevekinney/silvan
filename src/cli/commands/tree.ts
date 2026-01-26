import { basename, join } from 'node:path';

import type { CAC } from 'cac';

import { requireGitHubAuth, requireGitHubConfig } from '../../config/validate';
import type { RunContext } from '../../core/context';
import type { EventMode } from '../../events/schema';
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
} from '../../git/worktree';
import { findMergedPr } from '../../github/pr';
import { confirmAction } from '../../utils/confirm';
import { sanitizeName } from '../../utils/slug';
import { emitJsonSuccess } from '../json-output';
import { createCliLogger } from '../logger';
import {
  formatKeyList,
  formatKeyValues,
  renderNextSteps,
  renderSectionHeader,
  renderSuccessSummary,
} from '../output';
import type { CliOptions } from '../types';
import { deriveWorktreeStatus, renderWorktreeListTable } from '../worktree-list-output';

export type TreeCommandDeps = {
  withCliContext: <T>(
    options: CliOptions | undefined,
    mode: EventMode,
    fn: (ctx: RunContext) => Promise<T>,
  ) => Promise<T>;
  runStep: <T>(
    ctx: RunContext,
    stepId: string,
    title: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
};

export function registerTreeCommands(cli: CAC, deps: TreeCommandDeps): void {
  cli
    .command('tree list', 'List all git worktrees')
    .action(async (options: CliOptions) => {
      const mode: EventMode = options.json ? 'json' : 'headless';
      await deps.withCliContext(options, mode, async (ctx) => {
        const logger = createCliLogger(ctx);
        const worktrees = await deps.runStep(
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

        const nextSteps = ['silvan tree add <name>', 'silvan tree remove <name>'];

        if (options.json) {
          await emitJsonSuccess({
            command: 'tree list',
            data: {
              total: worktrees.length,
              worktrees: worktrees.map((worktree) => ({
                ...worktree,
                status: deriveWorktreeStatus(worktree),
              })),
            },
            nextSteps,
            runId: ctx.runId,
            repoRoot: ctx.repo.repoRoot,
          });
          return;
        }

        if (options.quiet) {
          return;
        }

        const lines: string[] = [];
        lines.push(renderWorktreeListTable(worktrees, { total: worktrees.length }));
        lines.push(renderNextSteps(nextSteps));
        await logger.info(lines.join('\n'));
      });
    });

  cli
    .command('tree add <name>', 'Create a new worktree with branch')
    .action(async (name: string, options: CliOptions) => {
      const mode: EventMode = options.json ? 'json' : 'headless';
      await deps.withCliContext(options, mode, async (ctx) => {
        const logger = createCliLogger(ctx);
        const safeName = sanitizeName(name);

        const worktree = await deps.runStep(
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

        const installResult = await deps.runStep(
          ctx,
          'deps.install',
          'Installing dependencies',
          () => installDependencies({ worktreePath: worktree.path }),
        );
        if (!installResult.ok) {
          await logger.warn(`Warning: bun install failed in ${worktree.path}`, {
            stderr: installResult.stderr,
            stdout: installResult.stdout,
          });
        }

        await logger.info(
          renderSuccessSummary({
            title: `Created worktree '${safeName}'`,
            details: [
              ['Path', worktree.path],
              ['Branch', worktree.branch ?? safeName],
            ],
            nextSteps: [`cd ${worktree.path}`, 'silvan task start "Your task"'],
          }),
        );
      });
    });

  cli
    .command('tree remove [name]', 'Remove a worktree')
    .option('--force', 'Force removal even if dirty')
    .option('--task <task>', 'Remove worktree for a task reference')
    .action(async (name: string | undefined, options: CliOptions) => {
      const mode: EventMode = options.json ? 'json' : 'headless';
      await deps.withCliContext(options, mode, async (ctx) => {
        const logger = createCliLogger(ctx);
        const task = options.task ? sanitizeName(options.task) : undefined;
        const targetName = name ? sanitizeName(name) : undefined;
        if (!task && !targetName) {
          throw new Error('Worktree name or --task is required.');
        }

        const worktrees = await deps.runStep(
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
            await logger.info('Canceled.');
            return;
          }
        }

        await deps.runStep(ctx, 'git.worktree.remove', 'Remove worktree', async () =>
          removeWorktree({
            repoRoot: ctx.repo.repoRoot,
            path: target.path,
            force: Boolean(options.force),
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
          }),
        );

        await logger.info(
          renderSuccessSummary({
            title: 'Removed worktree',
            details: [
              ['Path', target.path],
              ['Branch', target.branch ?? 'unknown'],
            ],
            nextSteps: ['silvan tree list', 'silvan tree add <name>'],
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
      await deps.withCliContext(options, mode, async (ctx) => {
        const logger = createCliLogger(ctx);
        const githubToken = requireGitHubAuth(ctx.config);
        const github = await requireGitHubConfig({
          config: ctx.config,
          repoRoot: ctx.repo.repoRoot,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        });

        const worktrees = await deps.runStep(
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
          if (worktree.path === ctx.repo.gitRoot) return false;
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
          await logger.info(
            renderSuccessSummary({
              title: 'No merged worktrees found',
              details: [['Candidates', `${candidates.length} worktree(s)`]],
              nextSteps: ['silvan tree list'],
            }),
          );
          return;
        }

        const removed: string[] = [];
        const skipped: string[] = [];

        for (const candidate of merged) {
          const isDirty = await hasUncommittedChanges({
            worktreePath: candidate.worktree.path,
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
          });
          if (isDirty && !options.force) {
            skipped.push(`${candidate.worktree.path} (dirty)`);
            continue;
          }

          let shouldRemove = Boolean(options.yes || options.all);
          if (!shouldRemove) {
            shouldRemove = await confirmAction(
              `Remove worktree ${candidate.worktree.path} (PR #${candidate.pr.number})?`,
            );
          }

          if (!shouldRemove) {
            skipped.push(`${candidate.worktree.path} (skipped)`);
            continue;
          }

          await deps.runStep(ctx, 'git.worktree.remove', 'Remove worktree', async () =>
            removeWorktree({
              repoRoot: ctx.repo.repoRoot,
              path: candidate.worktree.path,
              force: Boolean(options.force),
              bus: ctx.events.bus,
              context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
            }),
          );
          removed.push(candidate.worktree.path);
        }

        const remaining = Math.max(0, worktrees.length - removed.length);
        const summaryLines: string[] = [];
        summaryLines.push(
          renderSectionHeader('Cleaned worktrees', { width: 60, kind: 'minor' }),
        );
        summaryLines.push(
          ...formatKeyValues(
            [
              ['Removed', `${removed.length} worktree(s)`],
              ['Skipped', `${skipped.length} worktree(s)`],
              ['Remaining', `${remaining} worktree(s)`],
            ],
            { labelWidth: 12 },
          ),
        );
        if (removed.length > 0) {
          summaryLines.push(
            ...formatKeyList('Removed', `${removed.length} worktree(s)`, removed, {
              labelWidth: 12,
            }),
          );
        }
        if (skipped.length > 0) {
          summaryLines.push(
            ...formatKeyList('Skipped', `${skipped.length} worktree(s)`, skipped, {
              labelWidth: 12,
            }),
          );
        }
        summaryLines.push(renderNextSteps(['silvan tree list']));
        await logger.info(summaryLines.join('\n'));
      });
    });

  cli
    .command('tree prune', 'Prune stale worktree data')
    .action(async (options: CliOptions) => {
      const mode: EventMode = options.json ? 'json' : 'headless';
      await deps.withCliContext(options, mode, async (ctx) => {
        const logger = createCliLogger(ctx);
        await deps.runStep(ctx, 'git.worktree.prune', 'Prune worktrees', async () =>
          pruneWorktrees({
            repoRoot: ctx.repo.repoRoot,
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
          }),
        );
        await logger.info(
          renderSuccessSummary({
            title: 'Pruned worktree data',
            details: [['Repository', ctx.repo.repoRoot]],
            nextSteps: ['silvan tree list'],
          }),
        );
      });
    });

  cli
    .command('tree lock <name>', 'Lock a worktree')
    .option('--reason <reason>', 'Reason for locking')
    .action(async (name: string, options: CliOptions & { reason?: string }) => {
      const mode: EventMode = options.json ? 'json' : 'headless';
      await deps.withCliContext(options, mode, async (ctx) => {
        const logger = createCliLogger(ctx);
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
        await deps.runStep(ctx, 'git.worktree.lock', 'Lock worktree', async () =>
          lockWorktree({
            repoRoot: ctx.repo.repoRoot,
            path: target.path,
            ...(options.reason ? { reason: options.reason } : {}),
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
          }),
        );
        await logger.info(
          renderSuccessSummary({
            title: 'Locked worktree',
            details: [
              ['Path', target.path],
              ['Branch', target.branch ?? 'unknown'],
            ],
            nextSteps: ['silvan tree list', 'silvan tree unlock <name>'],
          }),
        );
      });
    });

  cli
    .command('tree unlock <name>', 'Unlock a worktree')
    .action(async (name: string, options: CliOptions) => {
      const mode: EventMode = options.json ? 'json' : 'headless';
      await deps.withCliContext(options, mode, async (ctx) => {
        const logger = createCliLogger(ctx);
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
        await deps.runStep(ctx, 'git.worktree.unlock', 'Unlock worktree', async () =>
          unlockWorktree({
            repoRoot: ctx.repo.repoRoot,
            path: target.path,
            bus: ctx.events.bus,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
          }),
        );
        await logger.info(
          renderSuccessSummary({
            title: 'Unlocked worktree',
            details: [
              ['Path', target.path],
              ['Branch', target.branch ?? 'unknown'],
            ],
            nextSteps: ['silvan tree list'],
          }),
        );
      });
    });

  cli
    .command('tree rebase', 'Rebase current branch onto base')
    .action(async (options: CliOptions) => {
      const mode: EventMode = options.json ? 'json' : 'headless';
      await deps.withCliContext(options, mode, async (ctx) => {
        const logger = createCliLogger(ctx);
        const ok = await deps.runStep(ctx, 'git.rebase', 'Rebase onto base', async () =>
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

        await logger.info(
          renderSuccessSummary({
            title: 'Rebase complete',
            details: [
              ['Branch', ctx.repo.branch ?? 'current'],
              ['Base', ctx.config.repo.defaultBranch],
            ],
            nextSteps: ['git status', 'silvan pr open'],
          }),
        );
      });
    });
}
