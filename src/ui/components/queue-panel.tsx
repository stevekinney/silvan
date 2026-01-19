import { Box, Text } from 'ink';
import React from 'react';

import { formatRelativeTime } from '../time';
import type { QueueRecord } from '../types';

export function QueuePanel({
  requests,
  nowMs,
}: {
  requests: QueueRecord[];
  nowMs: number;
}): React.ReactElement {
  if (requests.length === 0) {
    return <Text color="gray">Queue empty</Text>;
  }

  let currentRepo: string | undefined;

  return (
    <Box flexDirection="column" gap={0}>
      {requests.map((request) => {
        const repoLabel = request.repoLabel ?? request.repoId ?? 'current';
        const showRepo = repoLabel !== currentRepo;
        if (showRepo) {
          currentRepo = repoLabel;
        }
        const age = formatRelativeTime(request.createdAt, nowMs);
        const shortId = formatQueueId(request.id);
        return (
          <Box key={`${repoLabel}-${request.id}`} flexDirection="column">
            {showRepo ? <Text color="gray">{repoLabel}</Text> : null}
            <Box flexDirection="row" justifyContent="space-between">
              <Text>{`${shortId} ${request.title}`}</Text>
              <Text color="gray">{age} ago</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function formatQueueId(value: string): string {
  if (value.length <= 8) return value;
  return value.slice(0, 8);
}
