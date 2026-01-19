import { Box, Text } from 'ink';
import React from 'react';

import type { Phase } from '../../events/schema';
import type { PhaseTimelineEntry } from '../history';
import { formatElapsed } from '../time';

const PHASE_LABELS: Record<Phase, string> = {
  idle: 'idle',
  worktree: 'wt',
  plan: 'plan',
  implement: 'impl',
  verify: 'vrfy',
  pr: 'pr',
  ci: 'ci',
  review: 'revw',
  complete: 'done',
  failed: 'fail',
  canceled: 'canc',
};

const CELL_WIDTH = 6;

export function PhaseTimeline({
  phases,
}: {
  phases: PhaseTimelineEntry[];
}): React.ReactElement | null {
  if (phases.length === 0) return null;
  return (
    <Box flexDirection="column" gap={0}>
      <Box flexDirection="row">
        {phases.map((phase) => (
          <Text key={phase.phase}>{padLabel(PHASE_LABELS[phase.phase], CELL_WIDTH)}</Text>
        ))}
      </Box>
      <Box flexDirection="row">
        {phases.map((phase) => (
          <Text key={phase.phase} color={phaseStatusColor(phase.status)}>
            {padLabel(phaseStatusSymbol(phase.status), CELL_WIDTH)}
          </Text>
        ))}
      </Box>
      <Box flexDirection="row">
        {phases.map((phase) => {
          const duration =
            typeof phase.durationMs === 'number' ? formatElapsed(phase.durationMs) : '—';
          return (
            <Text key={phase.phase} color="gray">
              {padLabel(duration, CELL_WIDTH)}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

function phaseStatusSymbol(status: PhaseTimelineEntry['status']): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'running':
      return '●';
    case 'blocked':
      return '⚠';
    case 'failed':
      return '✗';
    case 'skipped':
      return '-';
    case 'pending':
    default:
      return '○';
  }
}

function phaseStatusColor(
  status: PhaseTimelineEntry['status'],
): 'green' | 'cyan' | 'yellow' | 'red' | 'gray' {
  switch (status) {
    case 'completed':
      return 'green';
    case 'running':
      return 'cyan';
    case 'blocked':
      return 'yellow';
    case 'failed':
      return 'red';
    case 'pending':
    case 'skipped':
    default:
      return 'gray';
  }
}

function padLabel(value: string, width: number): string {
  return value.padEnd(width, ' ');
}
