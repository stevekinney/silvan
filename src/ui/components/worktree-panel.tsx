import { basename } from 'node:path';

import { Box, Text } from 'ink';
import React from 'react';

import { truncateText } from '../../utils/text';
import { formatRelativeTime } from '../time';
import type { RunRecord, WorktreeRecord } from '../types';

type WorktreeRow = WorktreeRecord & {
  repoLabel: string;
  run?: RunRecord;
  isStale: boolean;
  isOrphaned: boolean;
};

export function WorktreePanel({
  worktrees,
  nowMs,
  maxItems,
  totalCount,
  compact = false,
  maxWidth,
}: {
  worktrees: WorktreeRow[];
  nowMs: number;
  maxItems?: number;
  totalCount?: number;
  compact?: boolean;
  maxWidth?: number;
}): React.ReactElement {
  const limit = typeof maxItems === 'number' ? Math.max(0, maxItems) : worktrees.length;
  const visible = worktrees.slice(0, limit);
  const total = totalCount ?? worktrees.length;
  const hiddenCount = Math.max(0, total - visible.length);
  const rowWidth = maxWidth ?? 80;

  if (visible.length === 0) {
    return <Text color="gray">No worktrees</Text>;
  }

  let currentRepo: string | undefined;

  return (
    <Box flexDirection="column" gap={0}>
      {visible.map((worktree) => {
        const repoLabel = worktree.repoLabel ?? worktree.repoId ?? 'current';
        const showRepo = !compact && repoLabel !== currentRepo;
        if (showRepo) {
          currentRepo = repoLabel;
        }
        const name = worktree.branch ?? basename(worktree.path);
        const displayName =
          compact && repoLabel !== 'current' ? `${repoLabel}:${name}` : name;
        const statusLabel = buildStatusLabel(worktree, nowMs);
        const runLabel = buildRunLabel(worktree.run);
        const headerColor =
          worktree.isStale || worktree.isOrphaned
            ? 'yellow'
            : worktree.isDirty
              ? 'yellow'
              : undefined;

        return (
          <Box
            key={`${repoLabel}-${worktree.id}`}
            flexDirection="column"
            marginBottom={compact ? 0 : 1}
          >
            {showRepo ? <Text color="gray">{repoLabel}</Text> : null}
            {compact ? (
              headerColor ? (
                <Text color={headerColor}>
                  {truncateText(
                    `${displayName}${formatCompactDetails(worktree, nowMs, rowWidth)}`,
                    rowWidth,
                  )}
                </Text>
              ) : (
                <Text>
                  {truncateText(
                    `${displayName}${formatCompactDetails(worktree, nowMs, rowWidth)}`,
                    rowWidth,
                  )}
                </Text>
              )
            ) : (
              <>
                {headerColor ? (
                  <Text color={headerColor}>{name}</Text>
                ) : (
                  <Text>{name}</Text>
                )}
                <Text color="gray">{worktree.relativePath ?? worktree.path}</Text>
                <Text color="gray">Branch: {worktree.branch ?? 'detached'}</Text>
                <Text color="gray">Run: {runLabel}</Text>
                <Text color="gray">Status: {statusLabel}</Text>
              </>
            )}
          </Box>
        );
      })}
      {hiddenCount > 0 ? (
        <Text color="gray">
          Showing {visible.length} of {total} worktrees. Run `silvan tree list` for full
          list.
        </Text>
      ) : null}
    </Box>
  );
}

function buildRunLabel(run: RunRecord | undefined): string {
  if (!run) return 'none';
  const status = run.status ?? 'unknown';
  return `${run.runId.slice(0, 8)} (${status})`;
}

function buildStatusLabel(worktree: WorktreeRow, nowMs: number): string {
  const parts = [] as string[];
  const dirtyLabel =
    worktree.isDirty === true
      ? 'dirty'
      : worktree.isDirty === false
        ? 'clean'
        : 'unknown';
  parts.push(dirtyLabel);
  if (worktree.isLocked) parts.push('locked');
  if (worktree.isStale) parts.push('stale');
  if (worktree.isOrphaned) parts.push('orphaned');
  const age = formatRelativeTime(worktree.lastActivityAt, nowMs);
  return `${parts.join(', ')} - last activity ${age} ago`;
}

function formatCompactDetails(
  worktree: WorktreeRow,
  nowMs: number,
  rowWidth: number,
): string {
  const statusParts = buildCompactStatusParts(worktree);
  const statusLabel = statusParts.length > 0 ? statusParts.join(', ') : 'unknown';
  const activity = formatRelativeTime(worktree.lastActivityAt, nowMs);
  const statusWidth = getStatusWidth(rowWidth);
  const activityLabel = `last ${activity}`;
  const details = [
    truncateText(statusLabel, statusWidth),
    truncateText(activityLabel, getActivityWidth(rowWidth)),
  ];
  return ` | ${details.join(' | ')}`;
}

function buildCompactStatusParts(worktree: WorktreeRow): string[] {
  const parts: string[] = [];
  if (worktree.isDirty) {
    parts.push('dirty');
  } else if (worktree.isDirty === false) {
    parts.push('clean');
  }
  if (worktree.isLocked) parts.push('locked');
  if (worktree.isStale) parts.push('stale');
  if (worktree.isOrphaned) parts.push('orphaned');
  if (!worktree.branch) parts.push('detached');
  return parts;
}

function getStatusWidth(rowWidth: number): number {
  if (rowWidth >= 80) return 24;
  if (rowWidth >= 60) return 18;
  if (rowWidth >= 40) return 14;
  return 10;
}

function getActivityWidth(rowWidth: number): number {
  if (rowWidth >= 80) return 18;
  if (rowWidth >= 60) return 14;
  if (rowWidth >= 40) return 12;
  return 10;
}
