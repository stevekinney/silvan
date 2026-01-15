import { loadConfig } from '../config/load';
import { createEnvelope } from '../events/emit';
import type { EventMode } from '../events/schema';
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
