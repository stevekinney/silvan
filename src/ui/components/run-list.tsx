import { Box, Text } from 'ink';
import React from 'react';

import { formatRelativeTime } from '../time';
import type { RunRecord } from '../types';
import { CiBadge, ReviewBadge, StatusBadge } from './badges';

export function RunList({
  runs,
  selectedRunId,
  groupByRepo = true,
  repoCounts,
  nowMs,
}: {
  runs: RunRecord[];
  selectedRunId?: string;
  groupByRepo?: boolean;
  repoCounts?: Map<string, number>;
  nowMs?: number;
}): React.ReactElement {
  if (runs.length === 0) {
    return <Text color="gray">No runs found. Try starting a task or run.</Text>;
  }

  let currentRepo: string | undefined;

  return (
    <Box flexDirection="column" gap={0}>
      {runs.map((run) => {
        const isSelected = run.runId === selectedRunId;
        const repoLabel = run.repoLabel ?? run.repoId ?? 'current';
        const showRepo = groupByRepo && repoLabel !== currentRepo;
        if (groupByRepo) {
          currentRepo = repoLabel;
        }
        const updated =
          nowMs !== undefined
            ? formatRelativeTime(run.latestEventAt ?? run.updatedAt, nowMs)
            : null;
        const repoCount = repoCounts?.get(repoLabel);
        return (
          <Box key={run.runId} flexDirection="column">
            {showRepo ? (
              <Text color="gray">
                {repoLabel}
                {repoCount !== undefined ? ` (${repoCount})` : ''}
              </Text>
            ) : null}
            <Box flexDirection="row" gap={1}>
              {isSelected ? (
                <Text color="cyan">{`▶ ${run.runId.slice(0, 8)}`}</Text>
              ) : (
                <Text>{`  ${run.runId.slice(0, 8)}`}</Text>
              )}
              <StatusBadge status={run.status} />
              <Text>{run.phase}</Text>
              {run.lastError ? <Text color="red">!</Text> : null}
              {run.step ? (
                <Text color="gray">{run.step.title ?? run.step.stepId}</Text>
              ) : null}
              {updated ? <Text color="gray">{updated} ago</Text> : null}
            </Box>
            <Box flexDirection="row" gap={1} marginLeft={2}>
              {run.pr ? (
                <Text color="cyan">{run.pr.id}</Text>
              ) : (
                <Text color="gray">No PR</Text>
              )}
              {run.ci ? <CiBadge state={run.ci.state} /> : <Text color="gray">CI ?</Text>}
              {run.review ? <ReviewBadge count={run.review.unresolvedCount} /> : null}
              {run.stuck ? <Text color="red">STUCK</Text> : null}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
