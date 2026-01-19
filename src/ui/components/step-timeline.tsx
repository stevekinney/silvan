import { Box, Text } from 'ink';
import React from 'react';

import type { StepHistoryEntry } from '../history';
import { formatElapsed, formatTimestamp } from '../time';

const MAX_STEPS = 6;

export function StepTimeline({
  steps,
  expanded = false,
  maxVisible = MAX_STEPS,
}: {
  steps: StepHistoryEntry[];
  expanded?: boolean;
  maxVisible?: number;
}): React.ReactElement {
  if (steps.length === 0) {
    return <Text color="gray">No steps recorded yet.</Text>;
  }

  const visible = expanded ? steps : steps.slice(-maxVisible);
  const remaining = steps.length - visible.length;

  return (
    <Box flexDirection="column">
      {visible.map((step) => {
        const timing = formatStepTiming(step);
        return (
          <Box key={step.stepId} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={stepStatusColor(step.status)}>
                {stepStatusSymbol(step.status)}
              </Text>
              <Text>{step.title}</Text>
              {timing ? <Text color="gray">{timing}</Text> : null}
            </Box>
            {step.error ? <Text color="red">{`  └─ ${step.error}`}</Text> : null}
          </Box>
        );
      })}
      {!expanded && remaining > 0 ? (
        <Text color="gray">{`+${remaining} more (press t)`}</Text>
      ) : null}
    </Box>
  );
}

function stepStatusSymbol(status: StepHistoryEntry['status']): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'running':
      return '●';
    case 'failed':
      return '✗';
    case 'skipped':
      return '-';
    case 'pending':
    default:
      return '○';
  }
}

function stepStatusColor(
  status: StepHistoryEntry['status'],
): 'green' | 'cyan' | 'red' | 'gray' {
  switch (status) {
    case 'completed':
      return 'green';
    case 'running':
      return 'cyan';
    case 'failed':
      return 'red';
    case 'pending':
    case 'skipped':
    default:
      return 'gray';
  }
}

function formatStepTiming(step: StepHistoryEntry): string | null {
  const parts: string[] = [];
  if (typeof step.durationMs === 'number') {
    parts.push(formatElapsed(step.durationMs));
  }
  const start = formatTimestamp(step.startedAt);
  const end = formatTimestamp(step.finishedAt);
  if (start !== 'unknown' && end !== 'unknown') {
    parts.push(`${start} → ${end}`);
  } else if (start !== 'unknown') {
    parts.push(`started ${start}`);
  } else if (end !== 'unknown') {
    parts.push(`ended ${end}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
