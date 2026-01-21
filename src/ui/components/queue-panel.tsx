import { Box, Text } from 'ink';
import React from 'react';

import { truncateText } from '../../utils/text';
import { formatRelativeTime } from '../time';
import type { QueueRecord } from '../types';

export function QueuePanel({
  requests,
  nowMs,
  hint,
  compact = false,
  maxItems,
  maxWidth,
}: {
  requests: QueueRecord[];
  nowMs: number;
  hint?: string;
  compact?: boolean;
  maxItems?: number;
  maxWidth?: number;
}): React.ReactElement {
  if (requests.length === 0) {
    return <Text color="gray">{compact ? 'Queue empty' : 'Queue empty'}</Text>;
  }

  const limit = typeof maxItems === 'number' ? Math.max(0, maxItems) : requests.length;
  const visible = requests.slice(0, limit);
  const hiddenCount = Math.max(0, requests.length - visible.length);
  const width = maxWidth ?? 60;

  let currentRepo: string | undefined;

  return (
    <Box flexDirection="column" gap={0}>
      {visible.map((request) => {
        const repoLabel = request.repoLabel ?? request.repoId ?? 'current';
        const showRepo = repoLabel !== currentRepo;
        if (showRepo) {
          currentRepo = repoLabel;
        }
        const age = formatRelativeTime(request.createdAt, nowMs);
        const shortId = formatQueueId(request.id);
        if (compact) {
          const line = `${shortId} ${request.title} (${age} ago)`;
          return (
            <Text key={`${repoLabel}-${request.id}`}>{truncateText(line, width)}</Text>
          );
        }
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
      {compact && hiddenCount > 0 ? (
        <Text color="gray">{truncateText(`... ${hiddenCount} more`, width)}</Text>
      ) : null}
      {!compact && hint ? (
        <Box marginTop={1}>
          <Text color="gray">{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function formatQueueId(value: string): string {
  if (value.length <= 8) return value;
  return value.slice(0, 8);
}
