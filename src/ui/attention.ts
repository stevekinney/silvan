import type { RunRecord } from './types';

const WAIT_THRESHOLD_MS = 30 * 60 * 1000;

export function needsAttention(run: RunRecord, nowMs = Date.now()): boolean {
  if (run.status === 'failed') return true;
  if (run.stuck) return true;
  const convergence = run.convergence?.status;
  if (convergence === 'blocked' || convergence === 'waiting_for_user') {
    return true;
  }
  if (convergence === 'waiting_for_ci' || convergence === 'waiting_for_review') {
    const waitTime = nowMs - getActivityTimestamp(run);
    return waitTime > WAIT_THRESHOLD_MS;
  }
  return false;
}

export function attentionReason(run: RunRecord, nowMs = Date.now()): string | undefined {
  if (run.status === 'failed') {
    return run.lastError?.message ?? 'Run failed';
  }
  if (run.stuck) {
    return run.stuck.reason;
  }
  if (run.blockedReason) {
    return run.blockedReason;
  }
  const convergenceMessage = run.convergence?.message;
  if (convergenceMessage) {
    return convergenceMessage;
  }
  const convergence = run.convergence?.status;
  if (convergence === 'waiting_for_ci' || convergence === 'waiting_for_review') {
    const waitTime = nowMs - getActivityTimestamp(run);
    const minutes = Math.floor(waitTime / 60000);
    return `Waiting ${minutes} min for ${convergence === 'waiting_for_ci' ? 'CI' : 'review'}`;
  }
  return undefined;
}

function getActivityTimestamp(run: RunRecord): number {
  const ts = run.latestEventAt ?? run.updatedAt;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}
