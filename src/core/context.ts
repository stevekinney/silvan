import { loadConfig } from '../config/load';
import { createEnvelope, toEventError } from '../events/emit';
import type { EventMode, RunFinished } from '../events/schema';
import { initStateStore } from '../state/store';
import { initEvents } from './events';
import { detectRepoContext } from './repo';

export type RunContext = {
  runId: string;
  repo: Awaited<ReturnType<typeof detectRepoContext>>;
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  state: Awaited<ReturnType<typeof initStateStore>>;
  events: Awaited<ReturnType<typeof initEvents>>;
};

export async function createRunContext(options: {
  cwd: string;
  mode: EventMode;
  lock?: boolean;
}): Promise<RunContext> {
  const runId = crypto.randomUUID();
  const repo = await detectRepoContext({ cwd: options.cwd });
  const configResult = await loadConfig();
  const state = await initStateStore(repo.repoRoot, {
    ...(options.lock !== undefined ? { lock: options.lock } : {}),
  });
  const events = initEvents(state, options.mode);

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
    state,
    events,
  };
}

export async function withRunContext<T>(
  options: { cwd: string; mode: EventMode; lock?: boolean },
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
    const payload: RunFinished = {
      status,
      durationMs: Date.now() - start,
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
    await emitRunFinished(isCanceled ? 'canceled' : 'failed', error);
    if (isCanceled) {
      process.exitCode = 130;
    }
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    if (options.lock !== false) {
      await ctx.state.lockRelease();
    }
  }
}

export class RunCanceledError extends Error {
  constructor() {
    super('Run canceled');
    this.name = 'RunCanceledError';
  }
}
