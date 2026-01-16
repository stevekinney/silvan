import { Box, Text } from 'ink';
import React from 'react';

import type { StateStore } from '../../state/store';
import type { RunRecord } from '../types';
import { ActivityFeed } from './activity-feed';
import { ArtifactPanel } from './artifact-panel';
import { StepTimeline } from './step-timeline';

export function RunDetails({
  run,
  stateStore,
}: {
  run: RunRecord;
  stateStore: StateStore;
}): React.ReactElement {
  const eventCount =
    typeof run.eventCount === 'number' ? String(run.eventCount) : 'unknown';
  const latestEventAt = run.latestEventAt ?? 'unknown';

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
        <Text>Last update</Text>
        <Text color="gray">{run.updatedAt}</Text>
        <Text color="gray">Events: {eventCount}</Text>
        <Text color="gray">Latest event: {latestEventAt}</Text>
      </Box>

      <Box flexDirection="column">
        <Text>Activity</Text>
        <ActivityFeed
          stateStore={stateStore}
          runId={run.runId}
          {...(run.repoId ? { repoId: run.repoId } : {})}
        />
      </Box>
    </Box>
  );
}
