import { Box, Text } from 'ink';
import React from 'react';

import { attentionReason } from '../attention';
import { formatRelativeTime } from '../time';
import type { RunRecord } from '../types';

export function AttentionQueue({
  runs,
  nowMs,
}: {
  runs: RunRecord[];
  nowMs: number;
}): React.ReactElement | null {
  if (runs.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text color="yellow">Needs Attention ({runs.length})</Text>
      {runs.map((run) => {
        const statusLabel = buildAttentionStatus(run);
        const updated = formatRelativeTime(run.latestEventAt ?? run.updatedAt, nowMs);
        const title = run.taskTitle ?? run.taskKey ?? 'Untitled';
        const reason = attentionReason(run, nowMs);
        return (
          <Box key={run.runId} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" gap={1}>
              <Text>{run.runId.slice(0, 8)}</Text>
              <Text color={statusLabel.color}>{statusLabel.label}</Text>
              <Text>{run.phase}</Text>
              <Text color="gray">{title}</Text>
              <Text color="gray">{updated} ago</Text>
            </Box>
            {reason ? (
              <Text color="gray">{`  └─ ${reason}`}</Text>
            ) : (
              <Text color="gray"> └─ Needs attention</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function buildAttentionStatus(run: RunRecord): { label: string; color: string } {
  if (run.status === 'failed') return { label: 'FAILED', color: 'red' };
  const convergence = run.convergence?.status;
  if (convergence === 'blocked' || convergence === 'waiting_for_user') {
    return { label: 'BLOCKED', color: 'yellow' };
  }
  if (run.stuck) {
    return { label: 'STUCK', color: 'red' };
  }
  return { label: run.status.toUpperCase(), color: 'cyan' };
}
