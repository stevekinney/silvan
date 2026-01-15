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
import { createWorktree, listWorktrees, removeWorktree } from '../git/worktree';
import { waitForCi } from '../github/ci';
import { openOrUpdatePr, requestReviewers } from '../github/pr';
import { fetchUnresolvedReviewComments } from '../github/review';
import { mountDashboard } from '../ui';
import { confirmAction } from '../utils/confirm';
import { hashString } from '../utils/hash';
import { sanitizeName } from '../utils/slug';

const cli = cac('silvan');

type CliOptions = {
  json?: boolean;
  yes?: boolean;
  force?: boolean;
  interval?: string;
  timeout?: string;
  noUi?: boolean;
  dryRun?: boolean;
  apply?: boolean;
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

      await runStep(ctx, 'git.worktree.create', 'Create worktree', async () =>
        createWorktree({
          repoRoot: ctx.repo.repoRoot,
          name: safeName,
          config: ctx.config,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        }),
      );
    });
  });

cli
  .command('wt remove <name>', 'Remove a worktree')
  .option('--force', 'Force removal even if dirty')
  .action(async (name: string, options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
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

      const targets = worktrees.filter(
        (worktree) => worktree.branch === name || basename(worktree.path) === name,
      );

      if (targets.length === 0) {
        throw new Error(`Worktree not found: ${name}`);
      }
      if (targets.length > 1) {
        const paths = targets.map((target) => target.path).join(', ');
        throw new Error(`Worktree name is ambiguous: ${name} (${paths})`);
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

cli.command('task start <ticket>', 'Start a task').action((ticket: string) =>
  withRunContext({ cwd: process.cwd(), mode: 'headless' }, async (ctx) => {
    const safeName = sanitizeName(ticket);
    await runStep(ctx, 'git.worktree.create', 'Create worktree', async () =>
      createWorktree({
        repoRoot: ctx.repo.repoRoot,
        name: safeName,
        config: ctx.config,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );
    await runPlanner(ctx, { ticketId: ticket, worktreeName: safeName });
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
  .action((options: CliOptions) =>
    withRunContext({ cwd: process.cwd(), mode: 'headless' }, async (ctx) => {
      const runOptions = {
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.apply ? { apply: true } : {}),
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
