import { Box, Text } from 'ink';
import React from 'react';

import type { RunRecord } from '../types';
import { CiBadge, ReviewBadge, StatusBadge } from './badges';

export function ArtifactPanel({ run }: { run: RunRecord }): React.ReactElement {
  return (
    <Box flexDirection="column" gap={0}>
      <Box flexDirection="row" gap={1}>
        <StatusBadge status={run.status} />
        <Text>{run.phase}</Text>
        {run.step ? <Text color="gray">{run.step.title ?? run.step.stepId}</Text> : null}
      </Box>
      {run.taskId ? (
        <Text color="magenta">
          {run.taskId} {run.taskTitle ? `• ${run.taskTitle}` : ''}
        </Text>
      ) : null}
      {run.pr ? (
        <Text color="cyan">
          {run.pr.id} {run.pr.url ? `• ${run.pr.url}` : ''}
        </Text>
      ) : (
        <Text color="gray">No PR yet</Text>
      )}
      <Box flexDirection="row" gap={1}>
        {run.ci ? <CiBadge state={run.ci.state} /> : <Text color="gray">CI ?</Text>}
        {run.review ? <ReviewBadge count={run.review.unresolvedCount} /> : null}
        {run.review?.iteration ? (
          <Text color="gray">Review #{run.review.iteration}</Text>
        ) : null}
      </Box>
      {run.stuck ? <Text color="red">Stuck: {run.stuck.reason}</Text> : null}
    </Box>
  );
}
