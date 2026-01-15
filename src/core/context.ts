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
}): Promise<RunContext> {
  const runId = crypto.randomUUID();
  const repo = await detectRepoContext({ cwd: options.cwd });
  const configResult = await loadConfig();
  const state = await initStateStore(repo.repoRoot);
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
  options: { cwd: string; mode: EventMode },
  fn: (ctx: RunContext) => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const ctx = await createRunContext(options);
  let finished = false;
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

  const onSigint = (): void => {
    void (async () => {
      if (finished) return;
      finished = true;
      await emitRunFinished('canceled');
      await ctx.state.lockRelease();
      process.exitCode = 130;
      process.exit();
    })();
  };

  process.once('SIGINT', onSigint);

  try {
    const result = await fn(ctx);
    finished = true;
    await emitRunFinished('success');
    return result;
  } catch (error) {
    finished = true;
    await emitRunFinished('failed', error);
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    await ctx.state.lockRelease();
  }
}
