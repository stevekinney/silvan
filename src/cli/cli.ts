import { basename } from 'node:path';

import { cac } from 'cac';

import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import { withRunContext } from '../core/context';
import type { EventMode } from '../events/schema';
import { runGit } from '../git/exec';
import { createWorktree, listWorktrees, removeWorktree } from '../git/worktree';
import { waitForCi } from '../github/ci';
import { openOrUpdatePr, requestReviewers } from '../github/pr';
import { fetchUnresolvedReviewComments } from '../github/review';
import { mountDashboard } from '../ui';
import { confirmAction } from '../utils/confirm';
import { sanitizeName } from '../utils/slug';

const cli = cac('silvan');

type CliOptions = {
  json?: boolean;
  yes?: boolean;
  force?: boolean;
  interval?: string;
  timeout?: string;
};

cli.option('--json', 'Output JSON event stream');
cli.option('--no-ui', 'Disable UI');
cli.option('--yes', 'Skip confirmations');

cli.command('wt list', 'List worktrees').action(async (options: CliOptions) => {
  const mode: EventMode = options.json ? 'json' : 'headless';
  await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
    await listWorktrees({
      repoRoot: ctx.repo.repoRoot,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      includeStatus: true,
    });
  });
});

cli
  .command('wt add <name>', 'Create a worktree and branch')
  .action(async (name: string, options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
      const safeName = sanitizeName(name);

      await createWorktree({
        repoRoot: ctx.repo.repoRoot,
        name: safeName,
        config: ctx.config,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
    });
  });

cli
  .command('wt remove <name>', 'Remove a worktree')
  .option('--force', 'Force removal even if dirty')
  .action(async (name: string, options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
      const worktrees = await listWorktrees({
        repoRoot: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        includeStatus: true,
      });

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

      await removeWorktree({
        repoRoot: ctx.repo.repoRoot,
        path: target.path,
        force: Boolean(options.force),
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
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
      const { owner, repo } = await requireGitHubConfig({
        config: ctx.config,
        repoRoot: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });

      const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
      const headBranch = branchResult.stdout.trim();

      const intervalMs = Number(options.interval ?? '15000');
      const timeoutMs = Number(options.timeout ?? '900000');

      await waitForCi({
        owner,
        repo,
        headBranch,
        pollIntervalMs: intervalMs,
        timeoutMs,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
    });
  });

cli
  .command('review unresolved', 'Fetch unresolved review comments')
  .action(async (options: CliOptions) => {
    const mode: EventMode = options.json ? 'json' : 'headless';
    await withRunContext({ cwd: process.cwd(), mode }, async (ctx) => {
      requireGitHubAuth();
      const { owner, repo } = await requireGitHubConfig({
        config: ctx.config,
        repoRoot: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });

      const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: ctx.repo.repoRoot,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
      const headBranch = branchResult.stdout.trim();

      await fetchUnresolvedReviewComments({
        owner,
        repo,
        headBranch,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      });
    });
  });

cli.command('ui', 'Launch the Ink dashboard').action(async () => {
  await withRunContext({ cwd: process.cwd(), mode: 'ui' }, async (ctx) => {
    await mountDashboard(ctx.events.bus, ctx.state);
  });
});

cli.command('task start <ticket>', 'Start a task (stub)').action((ticket: string) =>
  withRunContext({ cwd: process.cwd(), mode: 'headless' }, () => {
    console.log(`TODO: task start for ${ticket}`);
    return Promise.resolve();
  }),
);

cli.command('agent plan', 'Generate plan (stub)').action(() =>
  withRunContext({ cwd: process.cwd(), mode: 'headless' }, () => {
    console.log('TODO: agent plan');
    return Promise.resolve();
  }),
);

cli.command('agent run', 'Run agent (stub)').action(() =>
  withRunContext({ cwd: process.cwd(), mode: 'headless' }, () => {
    console.log('TODO: agent run');
    return Promise.resolve();
  }),
);

cli.command('agent resume', 'Resume agent (stub)').action(() =>
  withRunContext({ cwd: process.cwd(), mode: 'headless' }, () => {
    console.log('TODO: agent resume');
    return Promise.resolve();
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
    const { owner, repo } = await requireGitHubConfig({
      config: ctx.config,
      repoRoot: ctx.repo.repoRoot,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
    });

    const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ctx.repo.repoRoot,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
    });
    const headBranch = branchResult.stdout.trim();
    const baseBranch = ctx.config.github.baseBranch ?? ctx.config.repo.defaultBranch;
    const title = headBranch;
    const body = `Automated PR for ${headBranch}.`;

    const prResult = await openOrUpdatePr({
      owner,
      repo,
      headBranch,
      baseBranch,
      title,
      body,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
    });

    await requestReviewers({
      pr: prResult.pr,
      reviewers: ctx.config.github.reviewers,
      requestCopilot: ctx.config.github.requestCopilot,
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
    });
  });
}
