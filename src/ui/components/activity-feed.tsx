import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

import type { Event } from '../../events/schema';
import type { StateStore } from '../../state/store';
import { loadRunEvents } from '../loader';

export function ActivityFeed({
  stateStore,
  runId,
  repoId,
  limit = 8,
}: {
  stateStore: StateStore;
  runId: string;
  repoId?: string;
  limit?: number;
}): React.ReactElement {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const request = {
      state: stateStore,
      runId,
      limit,
      ...(repoId ? { repoId } : {}),
    };
    void loadRunEvents(request).then((next) => {
      if (!active) return;
      setEvents(next);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [stateStore, runId, repoId, limit]);

  if (loading) {
    return <Text color="gray">Loading activity…</Text>;
  }

  if (events.length === 0) {
    return <Text color="gray">No events recorded yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      {events.map((event) => (
        <Box key={`${event.id}:${event.ts}`} flexDirection="row" gap={1}>
          <Text color="gray">{formatEventTimestamp(event.ts)}</Text>
          <Text color={levelColor(event.level)}>{event.type}</Text>
          {event.source ? <Text color="gray">{event.source}</Text> : null}
          {event.message ? <Text color="gray">{event.message}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function levelColor(level: Event['level']): 'red' | 'yellow' | 'gray' {
  if (level === 'error') return 'red';
  if (level === 'warn') return 'yellow';
  return 'gray';
}

function formatEventTimestamp(value: string): string {
  if (!value) return 'unknown';
  const [date, time] = value.split('T');
  if (!time) return value;
  const trimmed = time.replace('Z', '').split('.')[0];
  return `${date} ${trimmed}`;
}
