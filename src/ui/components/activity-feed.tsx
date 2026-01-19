import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

import type { Event } from '../../events/schema';
import type { StateStore } from '../../state/store';
import { loadRunEvents } from '../loader';
import { formatTimestamp } from '../time';

export function ActivityFeed({
  stateStore,
  runId,
  repoId,
  limit = 8,
  events: providedEvents,
  loading: providedLoading,
}: {
  stateStore: StateStore;
  runId: string;
  repoId?: string;
  limit?: number;
  events?: Event[];
  loading?: boolean;
}): React.ReactElement {
  const [events, setEvents] = useState<Event[]>(providedEvents ?? []);
  const [loading, setLoading] = useState(providedLoading ?? true);

  useEffect(() => {
    if (providedEvents) {
      setEvents(providedEvents);
      setLoading(providedLoading ?? false);
      return;
    }
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
  }, [providedEvents, providedLoading, stateStore, runId, repoId, limit]);

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
          <Text color="gray">{formatTimestamp(event.ts)}</Text>
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
