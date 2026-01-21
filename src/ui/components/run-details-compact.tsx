import { Box, Text } from 'ink';
import React from 'react';

import { truncateText } from '../../utils/text';
import { formatRelativeTime } from '../time';
import type { RunRecord } from '../types';

export function RunDetailsCompact({
  run,
  nowMs,
  width,
  maxRows,
}: {
  run: RunRecord;
  nowMs: number;
  width: number;
  maxRows: number;
}): React.ReactElement {
  const lines = buildDetailLines(run, nowMs, width);
  const visible = lines.slice(0, Math.max(1, maxRows));

  return (
    <Box flexDirection="column">
      {visible.map((line, index) =>
        line.color ? (
          <Text key={`detail-${index}`} color={line.color}>
            {line.text}
          </Text>
        ) : (
          <Text key={`detail-${index}`}>{line.text}</Text>
        ),
      )}
    </Box>
  );
}

type DetailLine = {
  text: string;
  color?: 'gray' | 'yellow' | 'red' | 'cyan';
};

function buildDetailLines(run: RunRecord, nowMs: number, width: number): DetailLine[] {
  const lines: DetailLine[] = [];
  const status = `${run.status} / ${run.phase}`;
  const age = formatRelativeTime(run.latestEventAt ?? run.updatedAt, nowMs);

  lines.push({ text: truncateText(`Run ${run.runId.slice(0, 8)}`, width) });
  lines.push({
    text: truncateText(run.taskTitle ?? run.taskKey ?? 'Untitled task', width),
    color: 'gray',
  });
  lines.push({ text: truncateText(`Status: ${status}`, width), color: 'gray' });
  lines.push({ text: truncateText(`Updated: ${age} ago`, width), color: 'gray' });

  if (run.pr?.id) {
    lines.push({
      text: truncateText(`PR: ${run.pr.id}`, width),
      color: 'cyan',
    });
  } else {
    lines.push({ text: truncateText('PR: none', width), color: 'gray' });
  }

  if (run.ci?.state) {
    lines.push({
      text: truncateText(`CI: ${run.ci.state}`, width),
      color: run.ci.state === 'failing' ? 'red' : 'gray',
    });
  }

  if (typeof run.review?.unresolvedCount === 'number') {
    lines.push({
      text: truncateText(`Reviews: ${run.review.unresolvedCount} unresolved`, width),
      color: run.review.unresolvedCount > 0 ? 'yellow' : 'gray',
    });
  }

  if (run.step?.title) {
    lines.push({
      text: truncateText(`Step: ${run.step.title}`, width),
      color: 'gray',
    });
  }

  if (run.lastError?.message) {
    lines.push({
      text: truncateText(`Error: ${run.lastError.message}`, width),
      color: 'red',
    });
  }

  if (run.convergence?.status && run.convergence.status !== 'running') {
    lines.push({
      text: truncateText(`Convergence: ${run.convergence.status}`, width),
      color: run.convergence.status === 'failed' ? 'red' : 'yellow',
    });
  }

  return lines;
}
