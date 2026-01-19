import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

import type { CiState, Event } from '../../events/schema';
import { formatRelativeTime, formatTimestamp } from '../time';
import type { RunRecord } from '../types';

type CiCheck = NonNullable<NonNullable<RunRecord['ci']>['checks']>[number];

type PrDetails = {
  id?: string;
  title?: string;
  url?: string;
  headBranch?: string;
  baseBranch?: string;
  action?: string;
  openedAt?: string;
  updatedAt?: string;
  statusLabel: string;
};

type CiDetails = {
  state?: CiState;
  summary?: string;
  checks: CiCheck[];
};

export function PrCiReviewPanel({
  run,
  events,
  nowMs,
}: {
  run: RunRecord;
  events: Event[];
  nowMs: number;
}): React.ReactElement {
  const prDetails = useMemo(() => derivePrDetails(run, events), [events, run]);
  const ciDetails = useMemo(() => deriveCiDetails(run, events), [events, run]);
  const reviewSummary = useMemo(() => deriveReviewSummary(run), [run]);

  return (
    <Box flexDirection="column" gap={1}>
      <Text>PR / CI / Reviews</Text>

      <Box flexDirection="column">
        <Text color="gray">Pull Request</Text>
        {prDetails.id || prDetails.url || prDetails.title ? (
          <>
            <Text>{prDetails.title ?? prDetails.id ?? 'PR'}</Text>
            <Text color="gray">
              Branches {prDetails.headBranch ?? '—'} → {prDetails.baseBranch ?? '—'}
            </Text>
            <Text color="gray">Status {prDetails.statusLabel}</Text>
            {prDetails.url ? <Text color="blue">{prDetails.url}</Text> : null}
            {prDetails.openedAt ? (
              <Text color="gray">
                Opened {formatRelativeLabel(prDetails.openedAt, nowMs)}
              </Text>
            ) : null}
            {prDetails.updatedAt && prDetails.updatedAt !== prDetails.openedAt ? (
              <Text color="gray">
                Updated {formatRelativeLabel(prDetails.updatedAt, nowMs)}
              </Text>
            ) : null}
            {prDetails.action ? (
              <Text color="gray">Last action {prDetails.action}</Text>
            ) : null}
          </>
        ) : (
          <>
            <Text color="gray">No PR opened yet.</Text>
            <Text color="gray">The PR phase comes after verification passes.</Text>
          </>
        )}
      </Box>

      <Box flexDirection="column">
        <Text color="gray">CI Checks</Text>
        {ciDetails.checks.length > 0 ? (
          <>
            {ciDetails.checks.map((check) => {
              const status = formatCheckStatus(check);
              return (
                <Box key={check.name} flexDirection="row" gap={1}>
                  <Text color={status.color}>{status.symbol}</Text>
                  <Text>{check.name}</Text>
                  <Text color="gray">{status.label}</Text>
                </Box>
              );
            })}
            <Text color={ciOverallColor(ciDetails, ciDetails.checks)}>
              Overall {formatCiOverall(ciDetails, ciDetails.checks)}
            </Text>
          </>
        ) : ciDetails.state ? (
          <>
            <Text color={ciStateColor(ciDetails.state)}>
              Status {formatCiState(ciDetails.state)}
            </Text>
            {ciDetails.summary ? <Text color="gray">{ciDetails.summary}</Text> : null}
          </>
        ) : (
          <Text color="gray">No CI data yet.</Text>
        )}
        {run.ciFixSummary?.summary ? (
          <Text color="gray">
            CI fix plan: {run.ciFixSummary.summary}
            {typeof run.ciFixSummary.steps === 'number'
              ? ` (${run.ciFixSummary.steps} steps)`
              : ''}
          </Text>
        ) : null}
      </Box>

      <Box flexDirection="column">
        <Text color="gray">Reviews</Text>
        {reviewSummary.hasData ? (
          <>
            {reviewSummary.iteration ? (
              <Text color="gray">Iteration {reviewSummary.iteration}</Text>
            ) : null}
            {reviewSummary.unresolvedText ? (
              <Text color="gray">{reviewSummary.unresolvedText}</Text>
            ) : null}
            {reviewSummary.classificationText ? (
              <Text color="gray">{reviewSummary.classificationText}</Text>
            ) : null}
            {reviewSummary.fixPlanText ? (
              <Text color="gray">{reviewSummary.fixPlanText}</Text>
            ) : null}
            {reviewSummary.verificationText ? (
              <Text color={reviewSummary.verificationColor}>
                {reviewSummary.verificationText}
              </Text>
            ) : null}
          </>
        ) : (
          <Text color="gray">No review data yet.</Text>
        )}
      </Box>
    </Box>
  );
}

function derivePrDetails(run: RunRecord, events: Event[]): PrDetails {
  const prEvents = events
    .filter(
      (event): event is Extract<Event, { type: 'github.pr_opened_or_updated' }> =>
        event.type === 'github.pr_opened_or_updated',
    )
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const latest = prEvents[prEvents.length - 1];
  const opened =
    prEvents.find((event) => event.payload.action === 'opened') ?? prEvents[0];
  const eventPr = latest?.payload.pr;
  const id =
    run.pr?.id ??
    (eventPr ? `${eventPr.owner}/${eventPr.repo}#${eventPr.number}` : undefined);
  const details: PrDetails = { statusLabel: resolvePrStatusLabel(run) };
  if (id) details.id = id;
  const title = run.pr?.title ?? latest?.payload.title;
  if (title) details.title = title;
  const url = run.pr?.url ?? eventPr?.url;
  if (url) details.url = url;
  const headBranch = run.pr?.headBranch ?? latest?.payload.headBranch;
  if (headBranch) details.headBranch = headBranch;
  const baseBranch = run.pr?.baseBranch ?? latest?.payload.baseBranch;
  if (baseBranch) details.baseBranch = baseBranch;
  const action = run.pr?.action ?? latest?.payload.action;
  if (action) details.action = action;
  if (opened?.ts) details.openedAt = opened.ts;
  if (latest?.ts) details.updatedAt = latest.ts;
  return details;
}

function deriveCiDetails(run: RunRecord, events: Event[]): CiDetails {
  const ciEvents = events
    .filter(
      (event): event is Extract<Event, { type: 'ci.status' }> =>
        event.type === 'ci.status',
    )
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const latest = ciEvents[ciEvents.length - 1];
  const fromEvent = latest?.payload;
  const state = fromEvent?.state ?? run.ci?.state;
  const summary = fromEvent?.summary ?? run.ci?.summary;
  const checks = fromEvent?.checks ?? run.ci?.checks ?? [];
  const details: CiDetails = { checks };
  if (state) details.state = state;
  if (summary) details.summary = summary;
  return details;
}

function deriveReviewSummary(run: RunRecord): {
  hasData: boolean;
  iteration?: number;
  unresolvedText?: string;
  classificationText?: string;
  fixPlanText?: string;
  verificationText?: string;
  verificationColor: 'green' | 'red' | 'yellow' | 'gray';
} {
  const parts: {
    iteration?: number;
    unresolvedText?: string;
    classificationText?: string;
    fixPlanText?: string;
    verificationText?: string;
    verificationColor: 'green' | 'red' | 'yellow' | 'gray';
  } = {
    verificationColor: 'gray',
  };
  if (run.review?.iteration) {
    parts.iteration = run.review.iteration;
  }
  if (typeof run.review?.unresolvedCount === 'number') {
    parts.unresolvedText =
      typeof run.review.totalCount === 'number'
        ? `Threads ${run.review.unresolvedCount} unresolved / ${run.review.totalCount} total`
        : `Threads ${run.review.unresolvedCount} unresolved`;
  }
  if (run.reviewClassification) {
    parts.classificationText = `Classification ${run.reviewClassification.actionable} actionable, ${run.reviewClassification.ignored} ignored, ${run.reviewClassification.needsContext} needs context`;
  }
  if (run.reviewFixPlan) {
    parts.fixPlanText = `Fix plan ${run.reviewFixPlan.actionable} actionable, ${run.reviewFixPlan.ignored} ignored`;
  }
  if (run.reviewVerification) {
    parts.verificationText = `Review verification ${
      run.reviewVerification.ok ? 'passed' : 'failed'
    }${run.reviewVerification.lastRunAt ? ` • ${run.reviewVerification.lastRunAt}` : ''}`;
    parts.verificationColor = run.reviewVerification.ok ? 'green' : 'red';
  }

  return {
    hasData:
      Boolean(parts.iteration) ||
      Boolean(parts.unresolvedText) ||
      Boolean(parts.classificationText) ||
      Boolean(parts.fixPlanText) ||
      Boolean(parts.verificationText),
    ...parts,
  };
}

function resolvePrStatusLabel(run: RunRecord): string {
  if (run.status === 'canceled') return 'Closed';
  if (run.status === 'success' && run.phase === 'complete') return 'Merged';
  return 'Open';
}

function formatRelativeLabel(value: string, nowMs: number): string {
  const relative = formatRelativeTime(value, nowMs);
  if (relative === 'unknown') {
    return formatTimestamp(value);
  }
  return `${relative} ago`;
}

function formatCheckStatus(check: CiCheck): {
  symbol: string;
  color: 'green' | 'red' | 'yellow' | 'cyan' | 'gray';
  label: string;
} {
  if (check.conclusion === 'success') {
    return { symbol: '✓', color: 'green', label: 'passed' };
  }
  if (check.conclusion === 'failure') {
    return { symbol: '✗', color: 'red', label: 'failed' };
  }
  if (check.conclusion === 'cancelled') {
    return { symbol: '✗', color: 'red', label: 'cancelled' };
  }
  if (check.conclusion === 'skipped') {
    return { symbol: '-', color: 'gray', label: 'skipped' };
  }
  if (check.conclusion === 'neutral') {
    return { symbol: '○', color: 'gray', label: 'neutral' };
  }
  if (check.state === 'in_progress') {
    return { symbol: '●', color: 'cyan', label: 'running' };
  }
  if (check.state === 'queued') {
    return { symbol: '○', color: 'gray', label: 'queued' };
  }
  return { symbol: '○', color: 'gray', label: 'pending' };
}

function formatCiOverall(ci: CiDetails, checks: CiCheck[]): string {
  if (checks.length === 0) {
    return ci.state ? formatCiState(ci.state) : 'No checks';
  }
  const failed = checks.filter((check) => check.conclusion === 'failure');
  if (failed.length > 0) {
    return `${failed.length} check${failed.length > 1 ? 's' : ''} failed`;
  }
  const pending = checks.filter(
    (check) => check.state !== 'completed' || !check.conclusion,
  );
  if (pending.length > 0) {
    return `${pending.length} check${pending.length > 1 ? 's' : ''} running`;
  }
  return 'All checks passed';
}

function formatCiState(state: CiState): string {
  switch (state) {
    case 'passing':
      return 'Passing';
    case 'failing':
      return 'Failing';
    case 'pending':
      return 'Pending';
    default:
      return 'Unknown';
  }
}

function ciStateColor(state: CiState): 'green' | 'red' | 'yellow' | 'gray' {
  switch (state) {
    case 'passing':
      return 'green';
    case 'failing':
      return 'red';
    case 'pending':
      return 'yellow';
    default:
      return 'gray';
  }
}

function ciOverallColor(
  ci: CiDetails,
  checks: CiCheck[],
): 'green' | 'red' | 'yellow' | 'gray' {
  if (checks.some((check) => check.conclusion === 'failure')) return 'red';
  if (checks.some((check) => check.state !== 'completed')) return 'yellow';
  if (ci.state === 'passing') return 'green';
  if (ci.state === 'failing') return 'red';
  if (ci.state === 'pending') return 'yellow';
  return 'gray';
}
