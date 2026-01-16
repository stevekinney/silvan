import { Box, Text } from 'ink';
import React from 'react';

import type { RunStepSummary } from '../types';

const MAX_STEPS = 6;

export function StepTimeline({
  steps,
}: {
  steps?: RunStepSummary[];
}): React.ReactElement {
  if (!steps || steps.length === 0) {
    return <Text color="gray">No steps recorded yet.</Text>;
  }

  const ordered = [...steps].sort((a, b) => {
    const aTime = a.startedAt ?? a.endedAt ?? '';
    const bTime = b.startedAt ?? b.endedAt ?? '';
    return bTime.localeCompare(aTime);
  });

  return (
    <Box flexDirection="column">
      {ordered.slice(0, MAX_STEPS).map((step) => (
        <Box key={step.stepId} flexDirection="row" gap={1}>
          <Text color="gray">•</Text>
          <Text>{step.title ?? step.stepId}</Text>
          <Text color="gray">{step.status}</Text>
        </Box>
      ))}
    </Box>
  );
}
