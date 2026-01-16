import { Box, Text } from 'ink';
import React from 'react';

import type { RunRecord } from '../types';
import { ArtifactPanel } from './artifact-panel';
import { StepTimeline } from './step-timeline';

export function RunDetails({ run }: { run: RunRecord }): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1}>
      <Text>Run {run.runId}</Text>
      <ArtifactPanel run={run} />

      {run.lastError ? (
        <Box flexDirection="column">
          <Text color="red">Last error</Text>
          <Text color="red">{run.lastError.message}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column">
        <Text>Steps</Text>
        {run.steps ? (
          <StepTimeline steps={run.steps} />
        ) : (
          <Text color="gray">No steps recorded yet.</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text>Verification</Text>
        {run.verification ? (
          <Text color={run.verification.ok ? 'green' : 'red'}>
            {run.verification.ok ? 'Passed' : 'Failed'}
            {run.verification.lastRunAt ? ` • ${run.verification.lastRunAt}` : ''}
          </Text>
        ) : (
          <Text color="gray">No verification data</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text>Tool calls</Text>
        {run.toolCalls ? (
          <Text>{run.toolCalls.total} calls</Text>
        ) : (
          <Text color="gray">No tool calls recorded</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text>Last update</Text>
        <Text color="gray">{run.updatedAt}</Text>
      </Box>
    </Box>
  );
}
