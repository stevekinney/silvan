import { Box, Text } from 'ink';
import React from 'react';

import { truncateText } from '../../utils/text';
import type { DashboardState } from '../types';
import { CiBadge, ReviewBadge } from './badges';

export function OpenPrsPanel({
  prs,
  compact = false,
  maxItems,
  maxWidth,
}: {
  prs: DashboardState['openPrs'];
  compact?: boolean;
  maxItems?: number;
  maxWidth?: number;
}): React.ReactElement {
  if (prs.length === 0) {
    return <Text color="gray">{compact ? 'No PRs' : 'No open PRs'}</Text>;
  }

  const limit = typeof maxItems === 'number' ? Math.max(0, maxItems) : prs.length;
  const visible = prs.slice(0, limit);
  const hiddenCount = Math.max(0, prs.length - visible.length);
  const width = maxWidth ?? 60;

  return (
    <Box flexDirection="column" gap={0}>
      {visible.map((pr) =>
        compact ? (
          <Text key={pr.id}>{truncateText(formatCompactPr(pr), width)}</Text>
        ) : (
          <Box key={pr.id} flexDirection="column">
            <Text>
              {pr.id} {pr.title ? `• ${pr.title}` : ''}
            </Text>
            <Box flexDirection="row" gap={1} marginLeft={2}>
              <CiBadge state={pr.ci} />
              <ReviewBadge count={pr.unresolvedReviewCount} />
            </Box>
          </Box>
        ),
      )}
      {compact && hiddenCount > 0 ? (
        <Text color="gray">{truncateText(`... ${hiddenCount} more`, width)}</Text>
      ) : null}
    </Box>
  );
}

function formatCompactPr(pr: DashboardState['openPrs'][number]): string {
  const title = pr.title ? truncateText(pr.title, 40) : '';
  return `${pr.id} ci:${shortCi(pr.ci)} rev:${pr.unresolvedReviewCount} ${title}`.trim();
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
