import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

import type { EventBus } from '../events/bus';
import { applyDashboardEvent, createDashboardState } from './state';
import type { DashboardState } from './types';

export function Dashboard({ bus }: { bus: EventBus }): React.ReactElement {
  const [snapshot, setSnapshot] = useState<DashboardState>(createDashboardState);

  useEffect(() => {
    const unsubscribe = bus.subscribe((event) => {
      setSnapshot((prev) => applyDashboardEvent(prev, event));
    });

    return () => {
      unsubscribe();
    };
  }, [bus]);

  const runs = Object.values(snapshot.runs);

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text>Silvan Dashboard</Text>
        <Text>Runs: {runs.length}</Text>
      </Box>

      <Box flexDirection="column">
        <Text>Worktrees</Text>
        {snapshot.worktrees.length === 0 ? (
          <Text color="gray">No worktrees</Text>
        ) : (
          snapshot.worktrees.map((worktree) => (
            <Text key={worktree.id}>
              {worktree.branch ?? 'detached'} - {worktree.path}
            </Text>
          ))
        )}
      </Box>

      <Box flexDirection="column">
        <Text>Runs</Text>
        {runs.length === 0 ? (
          <Text color="gray">No active runs</Text>
        ) : (
          runs.map((run) => (
            <Box key={run.runId} flexDirection="column">
              <Text>
                {run.runId.slice(0, 8)} • {run.phase}
              </Text>
              {run.pr ? (
                <Text color="cyan">
                  PR {run.pr.id} • CI {run.pr.ci} • {run.pr.unresolvedReviewCount}{' '}
                  unresolved
                </Text>
              ) : (
                <Text color="gray">No PR yet</Text>
              )}
            </Box>
          ))
        )}
      </Box>

      <Box flexDirection="column">
        <Text>Open PRs</Text>
        {snapshot.openPrs.length === 0 ? (
          <Text color="gray">No open PRs</Text>
        ) : (
          snapshot.openPrs.map((pr) => (
            <Text key={pr.id}>
              {pr.id} • CI {pr.ci} • {pr.unresolvedReviewCount} unresolved
            </Text>
          ))
        )}
      </Box>

      <Text color="gray">Press q to quit.</Text>
    </Box>
  );
}
