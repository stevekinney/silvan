import { Box, Text } from 'ink';
import React from 'react';

import type { DashboardState } from '../types';
import { CiBadge, ReviewBadge } from './badges';

export function OpenPrsPanel({
  prs,
}: {
  prs: DashboardState['openPrs'];
}): React.ReactElement {
  if (prs.length === 0) {
    return <Text color="gray">No open PRs</Text>;
  }

  return (
    <Box flexDirection="column" gap={0}>
      {prs.map((pr) => (
        <Box key={pr.id} flexDirection="column">
          <Text>
            {pr.id} {pr.title ? `• ${pr.title}` : ''}
          </Text>
          <Box flexDirection="row" gap={1} marginLeft={2}>
            <CiBadge state={pr.ci} />
            <ReviewBadge count={pr.unresolvedReviewCount} />
          </Box>
        </Box>
      ))}
    </Box>
  );
}
