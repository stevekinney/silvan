import { createEnvelope } from '../events/emit';
import type { RunPersisted, RunPhaseChanged, RunStep } from '../events/schema';
import type { RunContext } from './context';

function buildContext(ctx: RunContext) {
  return { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode };
}

export async function emitRunPersisted(
  ctx: RunContext,
  payload: RunPersisted,
): Promise<void> {
  await ctx.events.bus.emit(
    createEnvelope({
      type: 'run.persisted',
      source: 'engine',
      level: 'info',
      context: buildContext(ctx),
      payload,
    }),
  );
}

export async function emitRunPhaseChanged(
  ctx: RunContext,
  payload: RunPhaseChanged,
): Promise<void> {
  await ctx.events.bus.emit(
    createEnvelope({
      type: 'run.phase_changed',
      source: 'engine',
      level: 'info',
      context: buildContext(ctx),
      payload,
    }),
  );
}

export async function emitRunStep(
  ctx: RunContext,
  payload: RunStep,
  level: 'info' | 'error' = 'info',
): Promise<void> {
  await ctx.events.bus.emit(
    createEnvelope({
      type: 'run.step',
      source: 'engine',
      level,
      context: buildContext(ctx),
      payload,
    }),
  );
}
