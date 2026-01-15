import { basename, join } from 'node:path';

import { cac } from 'cac';

import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import type { RunContext } from '../core/context';
import { withRunContext } from '../core/context';
import {
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
import { mountDashboard } from '../ui';
import { confirmAction } from '../utils/confirm';
import { hashString } from '../utils/hash';
import { sanitizeName } from '../utils/slug';
import { inferTicketFromRepo } from '../utils/ticket';

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
  ticket?: string;
};

cli.option('--json', 'Output JSON event stream');
cli.option('--no-ui', 'Disable UI');
cli.option('--yes', 'Skip confirmations');

cli.command('wt list', 'List worktrees').action(async (options: CliOptions) => {
  const mode: EventMode = options.json ? 'json' : 'headless';
  await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
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
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
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
  .option('--ticket <ticket>', 'Remove worktree for a Linear ticket ID')
  .action(async (name: string | undefined, options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
      const ticket = options.ticket ? sanitizeName(options.ticket) : undefined;
      const targetName = name ? sanitizeName(name) : undefined;
      if (!ticket && !targetName) {
        throw new Error('Worktree name or --ticket is required.');
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

      const expectedPath = ticket
        ? join(ctx.repo.repoRoot, ctx.config.naming.worktreeDir, ticket)
        : null;
      const expectedBranch = ticket ? `${ctx.config.naming.branchPrefix}${ticket}` : null;
      const targets = worktrees.filter((worktree) => {
        if (expectedPath && worktree.path === expectedPath) return true;
        if (expectedBranch && worktree.branch === expectedBranch) return true;
        if (targetName && worktree.branch === targetName) return true;
        if (targetName && basename(worktree.path) === targetName) return true;
        return false;
      });

      if (targets.length === 0) {
        throw new Error(`Worktree not found: ${ticket ?? targetName}`);
      }
      if (targets.length > 1) {
        const paths = targets.map((target) => target.path).join(', ');
        throw new Error(`Worktree name is ambiguous: ${ticket ?? targetName} (${paths})`);
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
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
      requireGitHubAuth();
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
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
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
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
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
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
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
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
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
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
      requireGitHubAuth();
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
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
      requireGitHubAuth();
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

cli.command('ui', 'Launch the Ink dashboard').action(async (options: CliOptions) => {
  if (options.noUi) {
    throw new Error('The --no-ui flag cannot be used with silvan ui.');
  }
  await withRunContext({ cwd: process.cwd(), mode: 'ui', lock: false }, async (ctx) => {
    await mountDashboard(ctx.events.bus, ctx.state);
  });
});

cli.command('task start [ticket]', 'Start a task').action((ticket: string | undefined) =>
  withRunContext({ cwd: process.cwd(), mode: 'headless' }, async (ctx) => {
    const mode = ctx.events.mode;
    const inferredFromRepo = await inferTicketFromRepo({
      repoRoot: ctx.repo.repoRoot,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
    });
    const inferred = ticket ?? inferredFromRepo?.ticketId;

    if (!inferred) {
      throw new Error(
        'Ticket ID required. Provide a ticket or use a branch with a ticket ID.',
      );
    }

    const safeName = sanitizeName(inferred);
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

    await runPlanner(ctx, { ticketId: inferred, worktreeName: safeName });
  }),
);

cli
  .command('agent plan', 'Generate plan')
  .option('--ticket <ticket>', 'Linear ticket ID')
  .action((options: CliOptions) =>
    withRunContext({ cwd: process.cwd(), mode: 'headless' }, async (ctx) => {
      await runPlanner(ctx, {
        ...(options.ticket ? { ticketId: options.ticket } : {}),
      });
    }),
  );

cli
  .command('agent run', 'Run agent')
  .option('--dry-run', 'Allow only read-only tools')
  .option('--apply', 'Allow mutating tools')
  .option('--dangerous', 'Allow dangerous tools (requires --apply)')
  .action((options: CliOptions) =>
    withRunContext({ cwd: process.cwd(), mode: 'headless' }, async (ctx) => {
      const runOptions = {
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.apply ? { apply: true } : {}),
        ...(options.dangerous ? { dangerous: true } : {}),
      };
      await runImplementation(ctx, runOptions);
      await runReviewLoop(ctx, runOptions);
    }),
  );

cli.command('agent resume', 'Resume agent').action(() =>
  withRunContext({ cwd: process.cwd(), mode: 'headless' }, async (ctx) => {
    await runRecovery(ctx);
  }),
);

cli
  .command('doctor', 'Check environment and configuration')
  .action(async (options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
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

      const ghTokenPresent = Boolean(Bun.env['GITHUB_TOKEN'] || Bun.env['GH_TOKEN']);
      results.push({
        name: 'github.token',
        ok: ghTokenPresent,
        detail: ghTokenPresent ? 'Found' : 'Missing GITHUB_TOKEN or GH_TOKEN',
      });

      if (ctx.config.linear.enabled) {
        const linearTokenPresent = Boolean(Bun.env['LINEAR_API_KEY']);
        results.push({
          name: 'linear.token',
          ok: linearTokenPresent,
          detail: linearTokenPresent ? 'Found' : 'Missing LINEAR_API_KEY',
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
  await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
    requireGitHubAuth();
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
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      }),
    );

    await runStep(ctx, 'github.review.request', 'Request reviewers', async () =>
      requestReviewers({
        pr: prResult.pr,
        reviewers: ctx.config.github.reviewers,
        requestCopilot: ctx.config.github.requestCopilot,
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
