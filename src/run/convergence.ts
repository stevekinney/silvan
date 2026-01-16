import type { ArtifactEntry } from '../state/artifacts';

export type RunConvergenceStatus =
  | 'running'
  | 'waiting_for_user'
  | 'waiting_for_ci'
  | 'waiting_for_review'
  | 'blocked'
  | 'converged'
  | 'failed'
  | 'aborted';

export type RunConvergence = {
  status: RunConvergenceStatus;
  reasonCode: string;
  message: string;
  blockingArtifacts?: string[];
  nextActions: Array<
    'resume' | 'rerun_gate' | 'override' | 'fix_code' | 'wait' | 'abort'
  >;
};

type StepRecord = {
  status?: 'not_started' | 'running' | 'done' | 'failed';
  startedAt?: string;
  endedAt?: string;
};

type RunMeta = {
  status?: 'running' | 'failed' | 'success' | 'canceled';
  phase?: string;
  step?: string;
};

type LocalGateSummary = { ok?: boolean; blockers?: number };

type RunSummary = {
  ci?: 'pending' | 'passing' | 'failing' | 'unknown';
  unresolvedReviewCount?: number;
  blockedReason?: string;
};

type RunStateData = Record<string, unknown> & {
  run?: RunMeta;
  steps?: Record<string, StepRecord>;
  summary?: RunSummary;
  localGateSummary?: LocalGateSummary;
};

export function flattenArtifactsIndex(
  index?: Record<string, Record<string, ArtifactEntry>>,
): ArtifactEntry[] {
  if (!index) return [];
  return Object.values(index).flatMap((entries) => Object.values(entries));
}

function findAbortArtifact(artifacts: ArtifactEntry[]): ArtifactEntry | undefined {
  return artifacts.find((entry) => entry.stepId === 'run.abort');
}

function hasOverrides(artifacts: ArtifactEntry[]): boolean {
  return artifacts.some((entry) => entry.stepId === 'overrides');
}

function getLocalGateBlockers(summary?: LocalGateSummary): number {
  const blockers = summary?.blockers;
  return typeof blockers === 'number' ? blockers : 0;
}

function listBlockingArtifacts(
  artifacts: ArtifactEntry[],
  predicate: (entry: ArtifactEntry) => boolean,
): string[] {
  return artifacts.filter(predicate).map((entry) => `${entry.stepId}/${entry.name}`);
}

function findRunningStep(steps: Record<string, StepRecord>): string | undefined {
  return Object.entries(steps).find(([, record]) => record?.status === 'running')?.[0];
}

function findFailedStep(steps: Record<string, StepRecord>): string | undefined {
  return Object.entries(steps).find(([, record]) => record?.status === 'failed')?.[0];
}

function hasPendingCi(steps: Record<string, StepRecord>, summary?: RunSummary): boolean {
  if (summary?.ci === 'pending') return true;
  return Object.entries(steps).some(([stepId, record]) => {
    if (!stepId.startsWith('ci.wait')) return false;
    return record?.status !== 'done' && record?.status !== 'failed';
  });
}

export function deriveRunConvergence(
  runState: RunStateData,
  artifacts: ArtifactEntry[],
): RunConvergence {
  const run = runState.run ?? {};
  const steps = runState.steps ?? {};
  const summary = runState.summary ?? {};
  const localGate = runState.localGateSummary;
  const abortArtifact = findAbortArtifact(artifacts);
  const overridesPresent = hasOverrides(artifacts);

  if (abortArtifact || run.status === 'canceled') {
    return {
      status: 'aborted',
      reasonCode: 'run_aborted',
      message: 'Run was aborted by the user.',
      blockingArtifacts: abortArtifact
        ? [`${abortArtifact.stepId}/${abortArtifact.name}`]
        : [],
      nextActions: [],
    };
  }

  if (run.status === 'failed') {
    return {
      status: 'failed',
      reasonCode: 'run_failed',
      message: 'Run finished with failure.',
      nextActions: ['resume', 'fix_code', 'abort'],
    };
  }

  if (run.status === 'success') {
    return {
      status: 'converged',
      reasonCode: 'run_complete',
      message: 'Run completed successfully.',
      nextActions: [],
    };
  }

  const runningStep = findRunningStep(steps);
  if (runningStep) {
    return {
      status: 'running',
      reasonCode: 'step_running',
      message: `Step ${runningStep} is running.`,
      nextActions: ['wait', 'abort'],
    };
  }

  const gateBlockers = getLocalGateBlockers(localGate);
  if (gateBlockers > 0 && !overridesPresent) {
    return {
      status: 'waiting_for_user',
      reasonCode: 'local_gate_blocked',
      message: 'Local review gate reported blockers.',
      blockingArtifacts: listBlockingArtifacts(
        artifacts,
        (entry) => entry.stepId === 'review.local_gate',
      ),
      nextActions: ['fix_code', 'rerun_gate', 'override', 'abort'],
    };
  }

  if (hasPendingCi(steps, summary)) {
    return {
      status: 'waiting_for_ci',
      reasonCode: 'ci_pending',
      message: 'Waiting for CI checks to complete.',
      blockingArtifacts: listBlockingArtifacts(artifacts, (entry) =>
        entry.stepId.startsWith('ci.wait'),
      ),
      nextActions: ['wait', 'abort'],
    };
  }

  if ((summary.unresolvedReviewCount ?? 0) > 0) {
    return {
      status: 'waiting_for_review',
      reasonCode: 'review_unresolved',
      message: 'Waiting on unresolved review threads.',
      blockingArtifacts: listBlockingArtifacts(
        artifacts,
        (entry) => entry.stepId === 'github.review.fetch',
      ),
      nextActions: ['resume', 'wait', 'abort'],
    };
  }

  if (summary.blockedReason) {
    return {
      status: 'blocked',
      reasonCode: 'blocked_reason',
      message: summary.blockedReason,
      nextActions: ['resume', 'fix_code', 'abort'],
    };
  }

  const failedStep = findFailedStep(steps);
  if (failedStep) {
    return {
      status: 'blocked',
      reasonCode: 'step_failed',
      message: `Step ${failedStep} failed and requires attention.`,
      nextActions: ['resume', 'fix_code', 'abort'],
    };
  }

  return {
    status: 'running',
    reasonCode: 'in_progress',
    message: 'Run is in progress.',
    nextActions: ['wait', 'abort'],
  };
}
