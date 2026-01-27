import { access } from 'node:fs/promises';
import { relative } from 'node:path';

import type { CAC } from 'cac';

import { loadConfig } from '../../config/load';
import type { RunContext } from '../../core/context';
import { SilvanError } from '../../core/errors';
import { detectRepoContext } from '../../core/repo';
import { runGit } from '../../git/exec';
import { evaluateLearningTargets } from '../../learning/auto-apply';
import { applyLearningNotes } from '../../learning/notes';
import type { ArtifactEntry } from '../../state/artifacts';
import { readArtifact } from '../../state/artifacts';
import {
  type LearningRequest,
  listLearningRequests,
  readLearningRequest,
  writeLearningRequest,
} from '../../state/learning';
import { initStateStore } from '../../state/store';
import { emitJsonResult, emitJsonSuccess } from '../json-output';
import { createCliLogger } from '../logger';
import {
  formatKeyList,
  formatKeyValues,
  renderNextSteps,
  renderSectionHeader,
  renderSuccessSummary,
} from '../output';
import type { CliOptions } from '../types';

export type LearningCommandDeps = {
  withCliContext: <T>(
    options: CliOptions | undefined,
    mode: 'json' | 'headless',
    fn: (ctx: RunContext) => Promise<T>,
  ) => Promise<T>;
  parseCsvFlag: (value: string | undefined) => string[] | undefined;
};

export function registerLearningCommands(cli: CAC, deps: LearningCommandDeps): void {
  cli
    .command('learning show <runId>', 'Show learning notes for a run')
    .action(async (runId: string, options: CliOptions) => {
      const { snapshot, repoRoot } = await loadRunSnapshotForCli(runId);
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
        await emitJsonSuccess({
          command: 'learning show',
          data: { runId, kind: notesEntry.kind, content },
          repoRoot,
          runId,
        });
        return;
      }
      if (notesEntry.kind === 'text') {
        console.log(content);
        return;
      }
      console.log(JSON.stringify(content, null, 2));
    });

  cli
    .command('learning review', 'Review pending learning notes')
    .option('--approve <runIds>', 'Approve pending learnings (comma-separated run IDs)')
    .option('--reject <runIds>', 'Reject pending learnings (comma-separated run IDs)')
    .option('--all', 'Apply action to all pending learnings')
    .action(
      (options: CliOptions & { approve?: string; reject?: string; all?: boolean }) =>
        deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) => {
          const logger = createCliLogger(ctx);
          const pending = await listPendingLearningRequests(ctx);
          const approveIds = deps.parseCsvFlag(options.approve);
          const rejectIds = deps.parseCsvFlag(options.reject);
          const action = resolveLearningReviewAction(options, approveIds, rejectIds);

          if (!action) {
            await renderPendingLearningRequests(ctx, logger, pending, options);
            return;
          }

          const { results, missing } = await applyLearningReviewAction(
            ctx,
            pending,
            action,
            {
              approveIds,
              rejectIds,
              all: Boolean(options.all),
            },
          );

          await renderLearningReviewResults(
            ctx,
            logger,
            action,
            results,
            missing,
            options,
          );
        }),
    );

  cli
    .command('learning rollback <runId>', 'Rollback applied learning updates')
    .action((runId: string, options: CliOptions) =>
      deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) => {
        const logger = createCliLogger(ctx);
        const result = await rollbackLearningRequestForCli(ctx, runId);

        if (options.json) {
          await emitJsonSuccess({
            command: 'learning rollback',
            data: result,
            repoRoot: ctx.repo.repoRoot,
            runId: ctx.runId,
          });
          return;
        }
        if (options.quiet) {
          return;
        }
        await logger.info(
          renderSuccessSummary({
            title: 'Learning rollback complete',
            details: [
              ['Run ID', runId],
              ['Revert', result.revertSha ?? 'unknown'],
            ],
            nextSteps: [`silvan run status ${runId}`, 'silvan learning review'],
          }),
        );
      }),
    );
}

type LearningReviewAction = 'approve' | 'reject';

type LearningReviewResult = {
  runId: string;
  status: string;
  message?: string;
};

async function listPendingLearningRequests(ctx: RunContext): Promise<LearningRequest[]> {
  const requests = await listLearningRequests({ state: ctx.state });
  return requests.filter((request) => request.status === 'pending');
}

function resolveLearningReviewAction(
  options: { all?: boolean },
  approveIds: string[] | undefined,
  rejectIds: string[] | undefined,
): LearningReviewAction | undefined {
  if (approveIds && rejectIds) {
    throw new SilvanError({
      code: 'learning.review.conflict',
      message: 'Choose either --approve or --reject.',
      userMessage: 'Choose either --approve or --reject.',
      kind: 'validation',
      nextSteps: ['Run `silvan learning review --approve <runId>` or `--reject`.'],
    });
  }

  const action = approveIds ? 'approve' : rejectIds ? 'reject' : undefined;
  if (options.all && !action) {
    throw new SilvanError({
      code: 'learning.review.missing_action',
      message: 'Specify --approve or --reject when using --all.',
      userMessage: 'Specify --approve or --reject when using --all.',
      kind: 'validation',
      nextSteps: ['Run `silvan learning review --approve --all`.'],
    });
  }

  return action;
}

async function renderPendingLearningRequests(
  ctx: RunContext,
  logger: ReturnType<typeof createCliLogger>,
  pending: LearningRequest[],
  options: CliOptions,
): Promise<void> {
  if (options.json) {
    await emitJsonSuccess({
      command: 'learning review',
      data: {
        pending: pending.map((request) => ({
          runId: request.runId,
          summary: request.summary,
          confidence: request.confidence,
          threshold: request.threshold,
          reason: request.reason ?? null,
          createdAt: request.createdAt,
        })),
      },
      repoRoot: ctx.repo.repoRoot,
      runId: ctx.runId,
    });
    return;
  }

  if (options.quiet) {
    return;
  }

  if (pending.length === 0) {
    await logger.info('No pending learning notes.');
    return;
  }

  const lines: string[] = [];
  lines.push(renderSectionHeader('Pending learning notes', { width: 60 }));
  lines.push(
    ...formatKeyValues([['Pending', `${pending.length} item(s)`]], {
      labelWidth: 12,
    }),
  );
  const summaries = pending.map((request) => {
    const confidence = `${Math.round(request.confidence * 100)}%`;
    return `${request.runId} (${confidence}): ${request.summary}`;
  });
  lines.push(
    ...formatKeyList('Items', `${pending.length} item(s)`, summaries, {
      labelWidth: 12,
    }),
  );
  lines.push(
    renderNextSteps([
      'silvan learning review --approve <runId>',
      'silvan learning review --reject <runId>',
    ]),
  );
  await logger.info(lines.join('\n'));
}

async function applyLearningReviewAction(
  ctx: RunContext,
  pending: LearningRequest[],
  action: LearningReviewAction,
  options: {
    approveIds: string[] | undefined;
    rejectIds: string[] | undefined;
    all: boolean;
  },
): Promise<{ results: LearningReviewResult[]; missing: string[] }> {
  const targetIds = options.all
    ? pending.map((request) => request.id)
    : action === 'approve'
      ? (options.approveIds ?? [])
      : (options.rejectIds ?? []);

  const selection = pending.filter((request) => targetIds.includes(request.id));
  const missing = targetIds.filter((id) => !pending.some((request) => request.id === id));
  const results: LearningReviewResult[] = [];

  for (const request of selection) {
    try {
      if (action === 'approve') {
        const result = await applyLearningRequestForCli(ctx, request);
        results.push({
          runId: request.runId,
          status: 'applied',
          ...(result.commitSha ? { message: `commit ${result.commitSha}` } : {}),
        });
      } else {
        await rejectLearningRequestForCli(ctx, request);
        results.push({ runId: request.runId, status: 'rejected' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Learning review failed';
      results.push({ runId: request.runId, status: 'failed', message });
    }
  }

  return { results, missing };
}

async function renderLearningReviewResults(
  ctx: RunContext,
  logger: ReturnType<typeof createCliLogger>,
  action: LearningReviewAction,
  results: LearningReviewResult[],
  missing: string[],
  options: CliOptions,
): Promise<void> {
  const failed = results.filter((result) => result.status === 'failed');

  if (options.json) {
    await emitJsonResult({
      command: 'learning review',
      success: failed.length === 0,
      data: {
        action,
        processed: results.length,
        failed: failed.length,
        missing,
        results,
      },
      ...(failed.length > 0
        ? {
            error: {
              code: 'learning.review.failed',
              message: 'One or more learning review actions failed.',
              details: { failed },
              suggestions: ['Inspect failures, then re-run the command.'],
            },
          }
        : {}),
      repoRoot: ctx.repo.repoRoot,
      runId: ctx.runId,
    });
    return;
  }

  if (options.quiet) {
    return;
  }

  const lines: string[] = [];
  const title =
    failed.length > 0
      ? 'Learning review completed with errors'
      : 'Learning review completed';
  lines.push(renderSectionHeader(title, { width: 60, kind: 'minor' }));
  lines.push(
    ...formatKeyValues(
      [
        ['Action', action],
        ['Processed', `${results.length} item(s)`],
        ['Failed', `${failed.length} item(s)`],
      ],
      { labelWidth: 12 },
    ),
  );
  if (missing.length > 0) {
    lines.push(
      ...formatKeyList('Missing', `${missing.length} item(s)`, missing, {
        labelWidth: 12,
      }),
    );
  }
  if (failed.length > 0) {
    lines.push(
      ...formatKeyList(
        'Failures',
        `${failed.length} item(s)`,
        failed.map((result) => `${result.runId}: ${result.message}`),
        { labelWidth: 12 },
      ),
    );
  }
  lines.push(renderNextSteps(['silvan learning review', 'silvan run list']));
  await logger.info(lines.join('\n'));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

async function loadRunSnapshotForCli(runId: string): Promise<{
  repoRoot: string;
  state: Awaited<ReturnType<typeof import('../../state/store').initStateStore>>;
  snapshot: Awaited<ReturnType<typeof import('../../run/controls').loadRunSnapshot>>;
}> {
  const { config, projectRoot } = await loadConfig(undefined, { cwd: process.cwd() });
  const repo = await detectRepoContext({ cwd: projectRoot });
  const state = await initStateStore(repo.projectRoot, {
    lock: false,
    mode: config.state.mode,
    ...(config.state.root ? { root: config.state.root } : {}),
    metadataRepoRoot: repo.gitRoot,
  });
  const snapshot = await state.readRunState(runId);
  if (!snapshot) {
    throw new Error(`Run not found: ${runId}`);
  }
  return { repoRoot: repo.projectRoot, state, snapshot };
}

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

async function applyLearningRequestForCli(
  ctx: RunContext,
  request: LearningRequest,
): Promise<{ appliedTo: string[]; commitSha?: string }> {
  const snapshot = await ctx.state.readRunState(request.runId);
  if (!snapshot) {
    throw new SilvanError({
      code: 'learning.review.run_missing',
      message: `Run not found: ${request.runId}`,
      userMessage: `Run not found: ${request.runId}`,
      kind: 'not_found',
      nextSteps: ['Run `silvan run list` to check available runs.'],
    });
  }
  const data = snapshot.data as Record<string, unknown>;
  const worktreeRoot = await resolveLearningWorktreeRoot(ctx, data, request.runId);
  const targetCheck = evaluateLearningTargets({
    targets: request.targets,
    worktreeRoot,
  });
  if (!targetCheck.ok) {
    throw new SilvanError({
      code: 'learning.review.unsafe_targets',
      message: targetCheck.reasons.join('; '),
      userMessage: 'Learning targets are not safe to apply automatically.',
      kind: 'validation',
      nextSteps: [
        'Update learning.targets to point at documentation files.',
        'Re-run `silvan learning review` after fixing the targets.',
      ],
    });
  }
  const applyResult = await applyLearningNotes({
    runId: request.runId,
    worktreeRoot,
    notes: request.notes,
    targets: request.targets,
  });
  const commitResult = await commitLearningRequestForCli({
    ctx,
    runId: request.runId,
    worktreeRoot,
    appliedTo: applyResult.appliedTo,
  });
  const appliedAt = new Date().toISOString();

  await ctx.state.updateRunState(request.runId, (prev) => ({
    ...prev,
    learningSummary: {
      ...(typeof prev['learningSummary'] === 'object' && prev['learningSummary']
        ? (prev['learningSummary'] as Record<string, unknown>)
        : {}),
      status: 'applied',
      appliedAt,
      appliedTo: applyResult.appliedTo,
      commitSha: commitResult.sha,
      autoApplied: false,
    },
  }));

  await writeLearningRequest({
    state: ctx.state,
    request: {
      ...request,
      status: 'applied',
      updatedAt: appliedAt,
      appliedAt,
      appliedTo: applyResult.appliedTo,
      ...(commitResult.sha ? { commitSha: commitResult.sha } : {}),
    },
  });

  return {
    appliedTo: applyResult.appliedTo,
    ...(commitResult.sha ? { commitSha: commitResult.sha } : {}),
  };
}

async function rejectLearningRequestForCli(
  ctx: RunContext,
  request: LearningRequest,
): Promise<void> {
  const rejectedAt = new Date().toISOString();
  await ctx.state.updateRunState(request.runId, (prev) => ({
    ...prev,
    learningSummary: {
      ...(typeof prev['learningSummary'] === 'object' && prev['learningSummary']
        ? (prev['learningSummary'] as Record<string, unknown>)
        : {}),
      status: 'rejected',
      rejectedAt,
    },
  }));
  await writeLearningRequest({
    state: ctx.state,
    request: {
      ...request,
      status: 'rejected',
      updatedAt: rejectedAt,
      rejectedAt,
    },
  });
}

async function rollbackLearningRequestForCli(
  ctx: RunContext,
  runId: string,
): Promise<{ runId: string; commitSha?: string; revertSha?: string }> {
  const snapshot = await ctx.state.readRunState(runId);
  if (!snapshot) {
    throw new SilvanError({
      code: 'learning.rollback.missing_run',
      message: `Run not found: ${runId}`,
      userMessage: `Run not found: ${runId}`,
      kind: 'not_found',
      nextSteps: ['Run `silvan run list` to check available runs.'],
    });
  }
  const data = snapshot.data as Record<string, unknown>;
  const learningSummary = (data['learningSummary'] as Record<string, unknown>) ?? {};
  const request = await readLearningRequest({ state: ctx.state, requestId: runId });
  const commitSha =
    (typeof learningSummary['commitSha'] === 'string'
      ? learningSummary['commitSha']
      : undefined) ?? request?.commitSha;

  if (!commitSha) {
    throw new SilvanError({
      code: 'learning.rollback.missing_commit',
      message: 'No learning commit found for this run.',
      userMessage: 'No learning commit found for this run.',
      kind: 'validation',
      nextSteps: ['Run `silvan learning review` to see pending notes.'],
    });
  }

  const worktreeRoot = await resolveLearningWorktreeRoot(ctx, data, runId);
  const revert = await runGit(['revert', '--no-edit', commitSha], {
    cwd: worktreeRoot,
    context: { runId, repoRoot: ctx.repo.repoRoot },
  });
  if (revert.exitCode !== 0) {
    throw new SilvanError({
      code: 'learning.rollback.failed',
      message: revert.stderr || 'Failed to revert learning commit.',
      userMessage: 'Failed to revert the learning commit.',
      kind: 'internal',
      nextSteps: [
        'Resolve conflicts in the worktree.',
        'Run `git revert --continue` or `git revert --abort`.',
      ],
    });
  }

  const shaResult = await runGit(['rev-parse', 'HEAD'], {
    cwd: worktreeRoot,
    context: { runId, repoRoot: ctx.repo.repoRoot },
  });
  const revertSha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : undefined;
  const rolledBackAt = new Date().toISOString();

  await ctx.state.updateRunState(runId, (prev) => ({
    ...prev,
    learningSummary: {
      ...(typeof prev['learningSummary'] === 'object' && prev['learningSummary']
        ? (prev['learningSummary'] as Record<string, unknown>)
        : {}),
      status: 'rolled_back',
      rolledBackAt,
      rollbackSha: revertSha,
    },
  }));

  if (request) {
    await writeLearningRequest({
      state: ctx.state,
      request: {
        ...request,
        status: 'rolled_back',
        updatedAt: rolledBackAt,
        rolledBackAt,
        commitSha,
      },
    });
  }

  return {
    runId,
    ...(commitSha ? { commitSha } : {}),
    ...(revertSha ? { revertSha } : {}),
  };
}

async function resolveLearningWorktreeRoot(
  ctx: RunContext,
  data: Record<string, unknown>,
  runId: string,
): Promise<string> {
  const worktree = (typeof data['worktree'] === 'object' && data['worktree']
    ? (data['worktree'] as { path?: string })
    : undefined) ?? { path: undefined };
  const candidate = worktree.path ?? ctx.repo.repoRoot;

  try {
    await access(candidate);
  } catch {
    throw new SilvanError({
      code: 'learning.review.worktree_missing',
      message: `Worktree not found for run ${runId}.`,
      userMessage: `Worktree not found for run ${runId}.`,
      kind: 'not_found',
      nextSteps: ['Run `silvan tree list` to locate the worktree.'],
    });
  }
  return candidate;
}

async function commitLearningRequestForCli(options: {
  ctx: RunContext;
  runId: string;
  worktreeRoot: string;
  appliedTo: string[];
}): Promise<{ committed: boolean; sha?: string }> {
  const relativePaths = options.appliedTo
    .map((filePath) => relative(options.worktreeRoot, filePath))
    .filter((path) => path && !path.startsWith('..'));
  if (relativePaths.length === 0) {
    return { committed: false };
  }
  await runGit(['add', '--', ...relativePaths], {
    cwd: options.worktreeRoot,
    context: { runId: options.runId, repoRoot: options.ctx.repo.repoRoot },
  });
  const diff = await runGit(['diff', '--cached', '--quiet'], {
    cwd: options.worktreeRoot,
    context: { runId: options.runId, repoRoot: options.ctx.repo.repoRoot },
  });
  if (diff.exitCode === 0) {
    return { committed: false };
  }
  const commit = await runGit(
    ['commit', '-m', `silvan: apply learnings (${options.runId})`],
    {
      cwd: options.worktreeRoot,
      context: { runId: options.runId, repoRoot: options.ctx.repo.repoRoot },
    },
  );
  if (commit.exitCode !== 0) {
    throw new Error(commit.stderr || 'Failed to commit learning updates');
  }
  const shaResult = await runGit(['rev-parse', 'HEAD'], {
    cwd: options.worktreeRoot,
    context: { runId: options.runId, repoRoot: options.ctx.repo.repoRoot },
  });
  const sha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : undefined;
  return { committed: true, ...(sha ? { sha } : {}) };
}
