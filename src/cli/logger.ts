import type { RunContext } from '../core/context';
import { createLogger } from '../core/logger';
import type { EmitContext } from '../events/emit';

export function buildEmitContext(ctx: RunContext): EmitContext {
  return {
    runId: ctx.runId,
    repoRoot: ctx.repo.repoRoot,
    mode: ctx.events.mode,
    ...(ctx.repo.worktreePath ? { worktreePath: ctx.repo.worktreePath } : {}),
  };
}

export function createCliLogger(ctx: RunContext) {
  return createLogger({
    bus: ctx.events.bus,
    source: 'cli',
    context: buildEmitContext(ctx),
  });
}
