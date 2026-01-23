import type { CAC } from 'cac';

import { requireGitHubAuth, requireGitHubConfig } from '../../config/validate';
import type { RunContext } from '../../core/context';
import type { EventMode } from '../../events/schema';
import { runGit } from '../../git/exec';
import { waitForCi } from '../../github/ci';
import { openOrUpdatePr, requestReviewers } from '../../github/pr';
import { fetchUnresolvedReviewComments } from '../../github/review';
import { hashString } from '../../utils/hash';
import { createCliLogger } from '../logger';
import { renderSuccessSummary } from '../output';
import type { CliOptions } from '../types';

type ReviewCommandDeps = {
  withCliContext: <T>(
    options: CliOptions,
    mode: EventMode,
    fn: (ctx: RunContext) => Promise<T>,
  ) => Promise<T>;
  runStep: <T>(
    ctx: RunContext,
    stepId: string,
    title: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
  persistRunState: (
    ctx: RunContext,
    mode: EventMode,
    updater: (data: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<void>;
};

export function registerReviewCommands(cli: CAC, deps: ReviewCommandDeps): void {
  cli
    .command('pr open', 'Open or update a pull request')
    .action(async (options: CliOptions) => {
      await handlePrOpen(options, deps);
    });

  cli
    .command('pr sync', 'Sync PR title/body and reviewers')
    .action(async (options: CliOptions) => {
      await handlePrOpen(options, deps);
    });

  cli
    .command('ci wait', 'Wait for CI to complete for current branch')
    .option('--interval <ms>', 'Polling interval in ms', { default: '15000' })
    .option('--timeout <ms>', 'Timeout in ms', { default: '900000' })
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
        const { owner, repo } = github;

        const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: ctx.repo.repoRoot,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        });
        const headBranch = branchResult.stdout.trim();

        const intervalMs = Number(options.interval ?? '15000');
        const timeoutMs = Number(options.timeout ?? '900000');

        const ciResult = await deps.runStep(ctx, 'github.ci.wait', 'Wait for CI', () =>
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

        await deps.persistRunState(ctx, mode, (data) => ({
          ...data,
          summary: {
            ...(typeof data['summary'] === 'object' && data['summary']
              ? data['summary']
              : {}),
            ci: ciResult.state,
          },
        }));

        if (github.source === 'origin') {
          await deps.persistRunState(ctx, mode, (data) => ({
            ...data,
            repo: {
              ...(typeof data['repo'] === 'object' && data['repo'] ? data['repo'] : {}),
              github: { owner, repo, source: github.source },
            },
          }));
        }

        const ciDetails: Array<[string, string]> = [
          ['Branch', headBranch],
          ['Status', ciResult.state],
        ];
        if (ciResult.summary) {
          ciDetails.push(['Summary', ciResult.summary]);
        }

        await logger.info(
          renderSuccessSummary({
            title: 'CI checks complete',
            details: ciDetails,
            nextSteps: ['silvan review unresolved', 'silvan pr open'],
          }),
        );
      });
    });

  cli
    .command('review unresolved', 'Fetch unresolved review comments')
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
        const { owner, repo } = github;

        const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: ctx.repo.repoRoot,
          bus: ctx.events.bus,
          context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
        });
        const headBranch = branchResult.stdout.trim();

        const reviewResult = await deps.runStep(
          ctx,
          'github.review.fetch',
          'Fetch review comments',
          () =>
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

        await deps.persistRunState(ctx, mode, (data) => ({
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
          await deps.persistRunState(ctx, mode, (data) => ({
            ...data,
            repo: {
              ...(typeof data['repo'] === 'object' && data['repo'] ? data['repo'] : {}),
              github: { owner, repo, source: github.source },
            },
          }));
        }

        await logger.info(
          renderSuccessSummary({
            title: 'Review comments fetched',
            details: [
              ['Branch', headBranch],
              [
                'PR',
                `${reviewResult.pr.owner}/${reviewResult.pr.repo}#${reviewResult.pr.number}`,
              ],
              ['URL', reviewResult.pr.url ?? 'unknown'],
              ['Unresolved', `${reviewResult.comments.length} comment(s)`],
            ],
            nextSteps: ['silvan run list', 'silvan pr open'],
          }),
        );
      });
    });
}

async function handlePrOpen(options: CliOptions, deps: ReviewCommandDeps): Promise<void> {
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

    const prResult = await deps.runStep(ctx, 'github.pr.open', 'Open or update PR', () =>
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

    await deps.runStep(ctx, 'github.review.request', 'Request reviewers', () =>
      requestReviewers({
        pr: prResult.pr,
        reviewers: ctx.config.github.reviewers,
        requestCopilot: ctx.config.github.requestCopilot,
        token: githubToken,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      }),
    );

    await deps.persistRunState(ctx, mode, (data) => ({
      ...data,
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary']
          ? data['summary']
          : {}),
        prUrl: prResult.pr.url,
      },
    }));

    const prTitle =
      prResult.action === 'opened'
        ? 'Pull request opened'
        : prResult.action === 'updated'
          ? 'Pull request updated'
          : 'Pull request up to date';
    await logger.info(
      renderSuccessSummary({
        title: prTitle,
        details: [
          ['PR', `${prResult.pr.owner}/${prResult.pr.repo}#${prResult.pr.number}`],
          ['URL', prResult.pr.url ?? 'unknown'],
        ],
        nextSteps: ['silvan ci wait', 'silvan review unresolved'],
      }),
    );

    if (github.source === 'origin') {
      await deps.persistRunState(ctx, mode, (data) => ({
        ...data,
        repo: {
          ...(typeof data['repo'] === 'object' && data['repo'] ? data['repo'] : {}),
          github: { owner, repo, source: github.source },
        },
      }));
    }
  });
}
