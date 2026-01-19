import { join } from 'node:path';

import { loadConfig } from '../config/load';
import type { ConfigInput } from '../config/schema';
import { createEnvelope, toEventError } from '../events/emit';
import type { EventMode, RunFinished } from '../events/schema';
import { initStateStore, updateRepoMetadata } from '../state/store';
import { normalizeError, RunCanceledError } from './errors';
import { initEvents } from './events';
import { detectRepoContext } from './repo';
import { formatRepoLabel } from './repo-label';

export type RunContext = {
  runId: string;
  repo: Awaited<ReturnType<typeof detectRepoContext>>;
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  configSource: Awaited<ReturnType<typeof loadConfig>>['source'];
  state: Awaited<ReturnType<typeof initStateStore>>;
  events: Awaited<ReturnType<typeof initEvents>>;
};

export async function createRunContext(options: {
  cwd: string;
  mode: EventMode;
  lock?: boolean;
  runId?: string;
  configOverrides?: ConfigInput;
}): Promise<RunContext> {
  const runId = options.runId ?? crypto.randomUUID();
  const repo = await detectRepoContext({ cwd: options.cwd });
  const configResult = await loadConfig(options.configOverrides);
  const state = await initStateStore(repo.repoRoot, {
    ...(options.lock !== undefined ? { lock: options.lock } : {}),
    mode: configResult.config.state.mode,
    ...(configResult.config.state.root ? { root: configResult.config.state.root } : {}),
  });
  const metadataPath = join(state.root, 'metadata.json');
  try {
    await updateRepoMetadata({
      metadataPath,
      repoRoot: repo.repoRoot,
      repoLabel: formatRepoLabel(configResult.config, repo.repoRoot, {
        includeHost: false,
        fallback: 'basename',
      }),
    });
  } catch {
    // Best-effort metadata update.
  }
  const events = initEvents(state, options.mode);

  await state.updateRunState(runId, (data) => {
    const now = new Date().toISOString();
    const existing = typeof data['run'] === 'object' && data['run'] ? data['run'] : {};
    const prior = existing as {
      version?: string;
      status?: string;
      phase?: string;
      step?: string;
      attempt?: number;
      updatedAt?: string;
    };
    return {
      ...data,
      run: {
        version: '1.0.0',
        status: 'running',
        phase: prior.phase ?? 'idle',
        step: prior.step,
        attempt: prior.attempt ?? 0,
        updatedAt: now,
      },
    };
  });

  const emitContext = {
    runId,
    repoRoot: repo.repoRoot,
    mode: options.mode,
    ...(repo.worktreePath ? { worktreePath: repo.worktreePath } : {}),
  };

  await events.bus.emit(
    createEnvelope({
      type: 'run.started',
      source: 'cli',
      level: 'info',
      context: emitContext,
      payload: {
        runId,
        command: 'silvan',
        args: [],
        cwd: options.cwd,
        repoRoot: repo.repoRoot,
      },
    }),
  );

  return {
    runId,
    repo,
    config: configResult.config,
    configSource: configResult.source,
    state,
    events,
  };
}

export async function withRunContext<T>(
  options: {
    cwd: string;
    mode: EventMode;
    lock?: boolean;
    runId?: string;
    configOverrides?: ConfigInput;
  },
  fn: (ctx: RunContext) => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const ctx = await createRunContext(options);
  let finished = false;
  let cancelRequested = false;
  let cancel: ((reason: RunCanceledError) => void) | undefined;
  const emitContext = {
    runId: ctx.runId,
    repoRoot: ctx.repo.repoRoot,
    mode: options.mode,
    ...(ctx.repo.worktreePath ? { worktreePath: ctx.repo.worktreePath } : {}),
  };
  const emitRunFinished = async (
    status: RunFinished['status'],
    error?: unknown,
  ): Promise<void> => {
    await ctx.state.updateRunState(ctx.runId, (data) => {
      const now = new Date().toISOString();
      const existing = typeof data['run'] === 'object' && data['run'] ? data['run'] : {};
      const prior = existing as {
        version?: string;
        status?: string;
        phase?: string;
        step?: string;
        attempt?: number;
      };
      return {
        ...data,
        run: {
          version: '1.0.0',
          status,
          phase: prior.phase ?? 'idle',
          step: prior.step,
          attempt: prior.attempt ?? 0,
          updatedAt: now,
        },
      };
    });

    const summary = await buildRunSummary(ctx);
    const payload: RunFinished = {
      status,
      durationMs: Date.now() - start,
      ...(summary ? { summary } : {}),
    };
    await ctx.events.bus.emit(
      createEnvelope({
        type: 'run.finished',
        source: 'cli',
        level: status === 'failed' ? 'error' : status === 'canceled' ? 'warn' : 'info',
        context: emitContext,
        payload,
        ...(error ? { error: toEventError(error) } : {}),
      }),
    );
  };

  const cancelPromise = new Promise<never>((_resolve, reject) => {
    cancel = reject as (reason: RunCanceledError) => void;
  });

  const onSigint = (): void => {
    if (finished || cancelRequested) return;
    cancelRequested = true;
    cancel?.(new RunCanceledError());
  };

  process.once('SIGINT', onSigint);

  try {
    const result = await Promise.race([fn(ctx), cancelPromise]);
    finished = true;
    await emitRunFinished('success');
    return result;
  } catch (error) {
    finished = true;
    const isCanceled = cancelRequested || error instanceof RunCanceledError;
    const normalized = normalizeError(error, {
      runId: ctx.runId,
      auditLogPath: join(ctx.state.auditDir, `${ctx.runId}.jsonl`),
    });
    await emitRunFinished(isCanceled ? 'canceled' : 'failed', normalized);
    if (normalized.exitCode !== undefined) {
      process.exitCode = normalized.exitCode;
    } else if (!isCanceled && process.exitCode === undefined) {
      process.exitCode = 1;
    }
    throw normalized;
  } finally {
    process.off('SIGINT', onSigint);
    if (options.lock !== false) {
      await ctx.state.lockRelease();
    }
  }
}

async function buildRunSummary(
  ctx: RunContext,
): Promise<RunFinished['summary'] | undefined> {
  const state = await ctx.state.readRunState(ctx.runId);
  const data = state?.data;
  if (!data || typeof data !== 'object') return undefined;

  const summary = (data as Record<string, unknown>)['summary'];
  if (!summary || typeof summary !== 'object') return undefined;

  const typed = summary as {
    prUrl?: unknown;
    ci?: unknown;
    unresolvedReviewCount?: unknown;
  };
  const prUrl = typeof typed.prUrl === 'string' ? typed.prUrl : undefined;
  const ci =
    typed.ci === 'pending' ||
    typed.ci === 'passing' ||
    typed.ci === 'failing' ||
    typed.ci === 'unknown'
      ? typed.ci
      : undefined;
  const unresolvedReviewCount =
    typeof typed.unresolvedReviewCount === 'number'
      ? typed.unresolvedReviewCount
      : undefined;

  if (!prUrl && !ci && unresolvedReviewCount === undefined) {
    return undefined;
  }

  return {
    ...(prUrl ? { prUrl } : {}),
    ...(ci ? { ci } : {}),
    ...(unresolvedReviewCount !== undefined ? { unresolvedReviewCount } : {}),
  };
}
