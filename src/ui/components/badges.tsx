import { Text } from 'ink';
import React from 'react';

import type { CiState } from '../../events/schema';
import type { RunStatus } from '../types';

export function StatusBadge({ status }: { status: RunStatus }): React.ReactElement {
  const color =
    status === 'success'
      ? 'green'
      : status === 'failed'
        ? 'red'
        : status === 'canceled'
          ? 'yellow'
          : status === 'running'
            ? 'cyan'
            : 'gray';
  return <Text color={color}>{status.toUpperCase()}</Text>;
}

export function CiBadge({ state }: { state: CiState }): React.ReactElement {
  const color =
    state === 'passing'
      ? 'green'
      : state === 'failing'
        ? 'red'
        : state === 'pending'
          ? 'yellow'
          : 'gray';
  return <Text color={color}>{state.toUpperCase()}</Text>;
}

export function ReviewBadge({ count }: { count: number }): React.ReactElement {
  const color = count > 0 ? 'yellow' : 'green';
  return <Text color={color}>{count} unresolved</Text>;
}
