import { Box, Text } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';

import type { Event } from '../../events/schema';
import type { StateStore } from '../../state/store';
import { buildPhaseTimeline, buildStepHistory } from '../history';
import { loadRunEvents } from '../loader';
import { formatElapsed, formatRelativeTime, formatTimestamp } from '../time';
import type { RunRecord } from '../types';
import { ActivityFeed } from './activity-feed';
import { ArtifactPanel } from './artifact-panel';
import { PhaseTimeline } from './phase-timeline';
import { StepTimeline } from './step-timeline';

export function RunDetails({
  run,
  stateStore,
  nowMs,
  stepsExpanded,
}: {
  run: RunRecord;
  stateStore: StateStore;
  nowMs: number;
  stepsExpanded: boolean;
}): React.ReactElement {
  const [events, setEvents] = useState<Event[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const eventCount =
    typeof run.eventCount === 'number' ? String(run.eventCount) : 'unknown';
  const latestEventAt = run.latestEventAt ?? 'unknown';
  const startedAt = run.startedAt ?? run.updatedAt;
  const startedLabel = formatRelativeTime(startedAt, nowMs);
  const startedText =
    startedLabel === 'unknown'
      ? `Started ${formatTimestamp(startedAt)}`
      : `Started ${startedLabel} ago`;
  const phaseTimeline = useMemo(
    () => buildPhaseTimeline(events, run, nowMs),
    [events, run, nowMs],
  );
  const activityEvents = useMemo(() => events.slice(-8), [events]);
  const stepHistory = useMemo(
    () => buildStepHistory(run.steps, events, nowMs),
    [events, nowMs, run.steps],
  );
  const currentPhaseEntry = useMemo(
    () =>
      phaseTimeline.find((entry) => entry.phase === run.phase) ??
      phaseTimeline.find((entry) => entry.status === 'running'),
    [phaseTimeline, run.phase],
  );
  const currentPhaseDuration =
    typeof currentPhaseEntry?.durationMs === 'number'
      ? formatElapsed(currentPhaseEntry.durationMs)
      : 'unknown';

  useEffect(() => {
    let active = true;
    setEventsLoading(true);
    void loadRunEvents({
      state: stateStore,
      runId: run.runId,
      ...(run.repoId ? { repoId: run.repoId } : {}),
    }).then((next) => {
      if (!active) return;
      setEvents(next);
      setEventsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [run.repoId, run.runId, run.updatedAt, stateStore]);

  return (
    <Box flexDirection="column" gap={1}>
      <Text>Run {run.runId}</Text>
      <Box flexDirection="column">
        <Text color="gray">{run.taskTitle ?? run.taskKey ?? 'Untitled task'}</Text>
        <Text color="gray">
          Source: {run.taskProvider ?? 'unknown'} • {startedText}
        </Text>
      </Box>

      {renderGateStatus(run)}

      <Box flexDirection="column">
        <Text>Phase Timeline</Text>
        <PhaseTimeline phases={phaseTimeline} />
        {currentPhaseEntry?.startedAt ? (
          <Text color="gray">
            Current phase: {run.phase} ({currentPhaseDuration}) • Started{' '}
            {formatTimestamp(currentPhaseEntry.startedAt)}
          </Text>
        ) : (
          <Text color="gray">Current phase: {run.phase}</Text>
        )}
      </Box>

      <ArtifactPanel run={run} />

      {run.lastError ? (
        <Box flexDirection="column">
          <Text color="red">Last error</Text>
          <Text color="red">{run.lastError.message}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column">
        <Text>
          Steps ({stepHistory.length} total) • {stepsExpanded ? 't collapse' : 't expand'}
        </Text>
        <StepTimeline steps={stepHistory} expanded={stepsExpanded} />
      </Box>

      <Box flexDirection="column">
        <Text>Last update</Text>
        <Text color="gray">{formatTimestamp(run.updatedAt)}</Text>
        <Text color="gray">Events: {eventCount}</Text>
        <Text color="gray">Latest event: {formatTimestamp(latestEventAt)}</Text>
      </Box>

      <Box flexDirection="column">
        <Text>Activity</Text>
        <ActivityFeed
          stateStore={stateStore}
          runId={run.runId}
          {...(run.repoId ? { repoId: run.repoId } : {})}
          events={activityEvents}
          loading={eventsLoading}
        />
      </Box>
    </Box>
  );
}

function renderGateStatus(run: RunRecord): React.ReactElement | null {
  const convergence = run.convergence;
  const status = convergence?.status;
  if (!status || status === 'running' || status === 'converged') {
    return null;
  }

  const label = gateStatusLabel(status);
  const color = gateStatusColor(status);
  const reason =
    convergence?.message ??
    run.blockedReason ??
    run.lastError?.message ??
    'Awaiting resolution';
  const nextActions = convergence?.nextActions ?? [];

  return (
    <Box flexDirection="column" borderStyle="round" padding={1}>
      <Text color={color}>{label}</Text>
      <Text color="gray">{reason}</Text>
      {nextActions.length > 0 ? (
        <Text color="gray">
          Next actions: {nextActions.map(formatNextAction).join(', ')}
        </Text>
      ) : null}
    </Box>
  );
}

function gateStatusLabel(status: string): string {
  switch (status) {
    case 'blocked':
    case 'waiting_for_user':
      return 'BLOCKED';
    case 'waiting_for_ci':
      return 'WAITING FOR CI';
    case 'waiting_for_review':
      return 'WAITING FOR REVIEW';
    case 'failed':
      return 'FAILED';
    case 'aborted':
      return 'ABORTED';
    default:
      return status.replace(/_/g, ' ').toUpperCase();
  }
}

function gateStatusColor(status: string): 'yellow' | 'red' | 'cyan' | 'gray' {
  switch (status) {
    case 'blocked':
    case 'waiting_for_user':
    case 'waiting_for_ci':
    case 'waiting_for_review':
      return 'yellow';
    case 'failed':
    case 'aborted':
      return 'red';
    default:
      return 'cyan';
  }
}

function formatNextAction(action: string): string {
  switch (action) {
    case 'rerun_gate':
      return 'rerun gate';
    case 'fix_code':
      return 'fix code';
    case 'resume':
      return 'resume';
    case 'override':
      return 'override';
    case 'wait':
      return 'wait';
    case 'abort':
      return 'abort';
    default:
      return action.replace(/_/g, ' ');
  }
}
