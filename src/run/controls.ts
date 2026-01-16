import type { ArtifactEntry } from '../state/artifacts';
import { writeArtifact } from '../state/artifacts';
import type { RunStateEnvelope, StateStore } from '../state/store';
import { hashString } from '../utils/hash';
import {
  deriveRunConvergence,
  flattenArtifactsIndex,
  type RunConvergence,
} from './convergence';

type RunStateData = Record<string, unknown>;

type OverridePayload = {
  reason: string;
  createdAt: string;
};

type AbortPayload = {
  reason?: string;
  createdAt: string;
};

function getRunStateData(snapshot: RunStateEnvelope): RunStateData {
  return snapshot.data as RunStateData;
}

function getArtifactsIndex(
  data: RunStateData,
): Record<string, Record<string, ArtifactEntry>> {
  return (
    (data['artifactsIndex'] as
      | Record<string, Record<string, ArtifactEntry>>
      | undefined) ?? {}
  );
}

async function updateArtifactsIndex(
  state: StateStore,
  runId: string,
  entry: ArtifactEntry,
): Promise<void> {
  await state.updateRunState(runId, (data) => {
    const artifactsIndex =
      (data['artifactsIndex'] as
        | Record<string, Record<string, ArtifactEntry>>
        | undefined) ?? {};
    return {
      ...data,
      artifactsIndex: {
        ...artifactsIndex,
        [entry.stepId]: {
          ...(artifactsIndex[entry.stepId] ?? {}),
          [entry.name]: entry,
        },
      },
    };
  });
}

export async function loadRunSnapshot(
  state: StateStore,
  runId: string,
): Promise<RunStateEnvelope> {
  const snapshot = await state.readRunState(runId);
  if (!snapshot) {
    throw new Error(`Run not found: ${runId}`);
  }
  return snapshot;
}

export function deriveConvergenceFromSnapshot(
  snapshot: RunStateEnvelope,
): RunConvergence {
  const data = getRunStateData(snapshot);
  const artifacts = flattenArtifactsIndex(getArtifactsIndex(data));
  return deriveRunConvergence(data, artifacts);
}

export async function writeOverrideArtifact(options: {
  state: StateStore;
  runId: string;
  reason: string;
}): Promise<ArtifactEntry> {
  const payload: OverridePayload = {
    reason: options.reason,
    createdAt: new Date().toISOString(),
  };
  const entry = await writeArtifact({
    state: options.state,
    runId: options.runId,
    stepId: 'overrides',
    name: `override-${hashString(payload.createdAt).slice(0, 8)}`,
    data: payload,
  });
  await updateArtifactsIndex(options.state, options.runId, entry);
  return entry;
}

export async function markRunAborted(options: {
  state: StateStore;
  runId: string;
  reason?: string;
}): Promise<ArtifactEntry> {
  const payload: AbortPayload = {
    ...(options.reason ? { reason: options.reason } : {}),
    createdAt: new Date().toISOString(),
  };
  const entry = await writeArtifact({
    state: options.state,
    runId: options.runId,
    stepId: 'run.abort',
    name: `abort-${hashString(payload.createdAt).slice(0, 8)}`,
    data: payload,
  });
  await updateArtifactsIndex(options.state, options.runId, entry);

  await options.state.updateRunState(options.runId, (data) => {
    const now = new Date().toISOString();
    const run = (data['run'] as Record<string, unknown>) ?? {};
    return {
      ...data,
      run: {
        ...run,
        status: 'canceled',
        updatedAt: now,
      },
    };
  });

  return entry;
}
