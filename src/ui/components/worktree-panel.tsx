import { basename } from 'node:path';

import { Box, Text } from 'ink';
import React from 'react';

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
}: {
  worktrees: WorktreeRow[];
  nowMs: number;
  maxItems?: number;
  totalCount?: number;
}): React.ReactElement {
  const limit = typeof maxItems === 'number' ? Math.max(0, maxItems) : worktrees.length;
  const visible = worktrees.slice(0, limit);
  const total = totalCount ?? worktrees.length;
  const hiddenCount = Math.max(0, total - visible.length);

  if (visible.length === 0) {
    return <Text color="gray">No worktrees</Text>;
  }

  let currentRepo: string | undefined;

  return (
    <Box flexDirection="column" gap={0}>
      {visible.map((worktree) => {
        const repoLabel = worktree.repoLabel ?? worktree.repoId ?? 'current';
        const showRepo = repoLabel !== currentRepo;
        if (showRepo) {
          currentRepo = repoLabel;
        }
        const name = worktree.branch ?? basename(worktree.path);
        const pathLabel = worktree.relativePath ?? worktree.path;
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
            marginBottom={1}
          >
            {showRepo ? <Text color="gray">{repoLabel}</Text> : null}
            {headerColor ? <Text color={headerColor}>{name}</Text> : <Text>{name}</Text>}
            <Text color="gray">{pathLabel}</Text>
            <Text color="gray">Branch: {worktree.branch ?? 'detached'}</Text>
            <Text color="gray">Run: {runLabel}</Text>
            <Text color="gray">Status: {statusLabel}</Text>
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
