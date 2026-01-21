import { Box, Text } from 'ink';
import React from 'react';

import { truncateText } from '../../utils/text';
import { formatRelativeTime } from '../time';
import type { RunRecord } from '../types';

type RunLine = {
  text: string;
  selected?: boolean;
  kind?: 'header' | 'overflow';
};

export function RunListCompact({
  runs,
  selectedRunId,
  nowMs,
  width,
  maxRows,
  groupByRepo = true,
}: {
  runs: RunRecord[];
  selectedRunId?: string;
  nowMs: number;
  width: number;
  maxRows: number;
  groupByRepo?: boolean;
}): React.ReactElement {
  if (runs.length === 0) {
    return <Text color="gray">No runs yet.</Text>;
  }

  const options: Parameters<typeof buildRunLines>[1] = {
    nowMs,
    width,
    groupByRepo,
  };
  if (selectedRunId) {
    options.selectedRunId = selectedRunId;
  }
  const lines = buildRunLines(runs, options);
  const capped = applyRowLimit(lines, maxRows, width);

  return (
    <Box flexDirection="column">
      {capped.map((line, index) => {
        if (line.kind === 'header') {
          return (
            <Text key={`header-${index}`} color="gray">
              {line.text}
            </Text>
          );
        }
        if (line.kind === 'overflow') {
          return (
            <Text key={`overflow-${index}`} color="gray">
              {line.text}
            </Text>
          );
        }
        return line.selected ? (
          <Text key={`run-${index}`} color="cyan">
            {line.text}
          </Text>
        ) : (
          <Text key={`run-${index}`}>{line.text}</Text>
        );
      })}
    </Box>
  );
}

function buildRunLines(
  runs: RunRecord[],
  options: {
    selectedRunId?: string;
    nowMs: number;
    width: number;
    groupByRepo: boolean;
  },
): RunLine[] {
  const lines: RunLine[] = [];
  let currentRepo: string | undefined;

  for (const run of runs) {
    const repoLabel = run.repoLabel ?? run.repoId ?? 'current';
    const showRepo = options.groupByRepo && repoLabel !== currentRepo;
    if (showRepo) {
      currentRepo = repoLabel;
      lines.push({
        text: truncateText(repoLabel, options.width),
        kind: 'header',
      });
    }

    const line = buildRunLine(run, options.width, options.nowMs);
    lines.push({
      text: line,
      selected: run.runId === options.selectedRunId,
    });
  }

  return lines;
}

function applyRowLimit(lines: RunLine[], maxRows: number, width: number): RunLine[] {
  if (lines.length <= maxRows) return lines;
  const visible = lines.slice(0, Math.max(1, maxRows - 1));
  const remaining = lines.length - visible.length;
  visible.push({
    text: truncateText(`... ${remaining} more`, width),
    kind: 'overflow',
  });
  return visible;
}

function buildRunLine(run: RunRecord, width: number, nowMs: number): string {
  const id = run.runId.slice(0, 8);
  const status = formatStatus(run.status);
  const phase = formatPhase(run.phase);
  const task = run.taskTitle ?? run.taskKey ?? 'Untitled';
  const age = formatRelativeTime(run.latestEventAt ?? run.updatedAt, nowMs);

  const prLabel = run.pr?.id ? shortPr(run.pr.id) : 'no-pr';
  const ciLabel = run.ci?.state ? `ci:${shortCi(run.ci.state)}` : 'ci:?';
  const reviewLabel =
    typeof run.review?.unresolvedCount === 'number'
      ? `rev:${run.review.unresolvedCount}`
      : 'rev:?';

  const parts = [
    `${id} ${status}/${phase}`,
    truncateText(task, Math.max(12, Math.floor(width * 0.4))),
    `${prLabel} ${ciLabel} ${reviewLabel}`,
    `${age} ago`,
  ];

  return truncateText(parts.join(' | '), width);
}

function formatStatus(status: string): string {
  switch (status) {
    case 'running':
      return 'RUN';
    case 'success':
      return 'OK';
    case 'failed':
      return 'FAIL';
    case 'canceled':
      return 'CANC';
    default:
      return 'UNKN';
  }
}

function formatPhase(phase: string): string {
  if (!phase) return 'unk';
  return phase.length <= 4 ? phase : phase.slice(0, 4);
}

function shortPr(id: string): string {
  const parts = id.split('#');
  if (parts.length === 2) {
    return `#${parts[1]}`;
  }
  return id.length > 8 ? id.slice(0, 8) : id;
}

function shortCi(state: string): string {
  switch (state) {
    case 'passing':
      return 'ok';
    case 'failing':
      return 'bad';
    case 'pending':
      return 'wait';
    default:
      return 'unk';
  }
}
