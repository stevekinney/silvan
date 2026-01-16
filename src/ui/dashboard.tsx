import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { EventBus } from '../events/bus';
import { writeQueueRequest } from '../state/queue';
import type { StateStore } from '../state/store';
import { FilterBar } from './components/filter-bar';
import { HelpOverlay } from './components/help-overlay';
import { OpenPrsPanel } from './components/open-prs-panel';
import { RequestForm } from './components/request-form';
import { RunDetails } from './components/run-details';
import { RunList } from './components/run-list';
import {
  createRunSnapshotCache,
  loadRunSnapshots,
  type RunSnapshotCursor,
} from './loader';
import { applyDashboardEvent, applyRunSnapshots, createDashboardState } from './state';
import type { DashboardState, RunRecord } from './types';

const EVENT_FLUSH_MS = 120;
const PAGE_SIZE = 25;

export function Dashboard({
  bus,
  stateStore,
}: {
  bus: EventBus;
  stateStore: StateStore;
}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<DashboardState>(createDashboardState);
  const [filterActive, setFilterActive] = useState(false);
  const [filterValue, setFilterValue] = useState('');
  const [detailsView, setDetailsView] = useState(false);
  const [requestActive, setRequestActive] = useState(false);
  const [requestStep, setRequestStep] = useState<'title' | 'description'>('title');
  const [requestTitle, setRequestTitle] = useState('');
  const [requestDescription, setRequestDescription] = useState('');
  const [nextCursor, setNextCursor] = useState<RunSnapshotCursor | null>(null);
  const { stdout } = useStdout();
  const isNarrow = (stdout?.columns ?? 100) < 100;
  const { exit } = useApp();
  const loaderCache = useRef(createRunSnapshotCache());

  const queueRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventQueue = useRef([] as Parameters<typeof applyDashboardEvent>[1][]);

  useEffect(() => {
    void refreshRuns(PAGE_SIZE);
  }, [stateStore]);

  useEffect(() => {
    const flush = () => {
      setSnapshot((prev) => {
        let next = prev;
        for (const event of eventQueue.current) {
          next = applyDashboardEvent(next, event);
        }
        eventQueue.current = [];
        return next;
      });
      queueRef.current = null;
    };

    const unsubscribe = bus.subscribe((event) => {
      eventQueue.current.push(event);
      if (!queueRef.current) {
        queueRef.current = setTimeout(flush, EVENT_FLUSH_MS);
      }
    });

    return () => {
      unsubscribe();
      if (queueRef.current) {
        clearTimeout(queueRef.current);
        queueRef.current = null;
      }
    };
  }, [bus]);

  const runs = useMemo(() => {
    const all = snapshot.runIndex
      .map((id) => snapshot.runs[id])
      .filter((run): run is RunRecord => Boolean(run));
    const query = snapshot.filter.query.trim().toLowerCase();
    if (!query) return all;
    return all.filter((run) => matchesQuery(run, query));
  }, [snapshot]);

  const selectedRunId =
    runs.find((run) => run.runId === snapshot.selection)?.runId ?? runs[0]?.runId;
  const selectedRun = selectedRunId
    ? runs.find((run) => run.runId === selectedRunId)
    : undefined;

  useInput((input, key) => {
    if (requestActive) {
      if (key.escape) {
        setRequestActive(false);
        setRequestStep('title');
        setRequestTitle('');
        setRequestDescription('');
        return;
      }
      return;
    }
    if (filterActive) {
      if (key.escape) {
        setFilterActive(false);
        setFilterValue('');
        return;
      }
      return;
    }

    if (input === 'q') {
      exit();
    }
    if (input === '?') {
      setSnapshot((prev) => ({ ...prev, helpVisible: !prev.helpVisible }));
      return;
    }
    if (input === 'n') {
      setRequestActive(true);
      setRequestStep('title');
      setRequestTitle('');
      setRequestDescription('');
      return;
    }
    if (input === '/') {
      setFilterActive(true);
      setFilterValue(snapshot.filter.query);
      return;
    }
    if (input === 'r') {
      const limit = Math.max(PAGE_SIZE, snapshot.runIndex.length || 0);
      void refreshRuns(limit);
      return;
    }
    if (input === 'l') {
      void loadMoreRuns();
      return;
    }
    if (input === 'b') {
      setDetailsView(false);
      return;
    }
    if (key.return) {
      if (isNarrow) {
        setDetailsView(true);
      }
      return;
    }

    if (key.downArrow || input === 'j') {
      moveSelection(1);
    }
    if (key.upArrow || input === 'k') {
      moveSelection(-1);
    }
  });

  async function enqueueTaskRequest(): Promise<void> {
    const title = requestTitle.trim();
    if (!title) return;
    await writeQueueRequest({
      state: stateStore,
      request: {
        id: crypto.randomUUID(),
        type: 'start-task',
        title,
        ...(requestDescription.trim() ? { description: requestDescription.trim() } : {}),
        createdAt: new Date().toISOString(),
      },
    });
    setRequestActive(false);
    setRequestStep('title');
    setRequestTitle('');
    setRequestDescription('');
  }

  function moveSelection(delta: number) {
    if (runs.length === 0) return;
    const index = runs.findIndex((run) => run.runId === selectedRunId);
    const nextIndex = Math.min(Math.max(index + delta, 0), runs.length - 1);
    const nextRunId = runs[nextIndex]?.runId;
    if (nextRunId) {
      setSnapshot((prev) => ({ ...prev, selection: nextRunId }));
    }
  }

  async function refreshRuns(limit: number): Promise<void> {
    const page = await loadRunSnapshots(stateStore, {
      limit,
      cache: loaderCache.current,
    });
    setSnapshot((prev) => applyRunSnapshots(prev, page.runs));
    setNextCursor(page.nextCursor ?? null);
  }

  async function loadMoreRuns(): Promise<void> {
    if (!nextCursor) return;
    const page = await loadRunSnapshots(stateStore, {
      limit: PAGE_SIZE,
      cursor: nextCursor,
      cache: loaderCache.current,
    });
    setSnapshot((prev) => applyRunSnapshots(prev, page.runs));
    setNextCursor(page.nextCursor ?? null);
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>Silvan Mission Control</Text>
        <Text color="gray">
          {runs.length} runs • / filter • ? help
          {nextCursor ? ' • l load more' : ''}
        </Text>
      </Box>

      {filterActive ? (
        <FilterBar
          query={filterValue}
          onChange={setFilterValue}
          onSubmit={() => {
            setSnapshot((prev) => ({ ...prev, filter: { query: filterValue } }));
            setFilterActive(false);
          }}
        />
      ) : null}

      {requestActive ? (
        <RequestForm
          step={requestStep}
          title={requestTitle}
          description={requestDescription}
          onTitleChange={setRequestTitle}
          onDescriptionChange={setRequestDescription}
          onSubmit={() => {
            if (requestStep === 'title') {
              if (!requestTitle.trim()) return;
              setRequestStep('description');
              return;
            }
            void enqueueTaskRequest();
          }}
        />
      ) : null}

      {runs.length === 0 ? (
        <Text color="gray">
          No runs yet. Press n to queue a task, then run `silvan queue run`.
        </Text>
      ) : isNarrow ? (
        detailsView && selectedRun ? (
          <RunDetails run={selectedRun} stateStore={stateStore} />
        ) : (
          <RunList runs={runs} {...(selectedRunId ? { selectedRunId } : {})} />
        )
      ) : (
        <Box flexDirection="row" gap={4}>
          <Box width={40} flexDirection="column">
            <RunList runs={runs} {...(selectedRunId ? { selectedRunId } : {})} />
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Open PRs</Text>
              <OpenPrsPanel prs={snapshot.openPrs} />
            </Box>
          </Box>
          <Box flexGrow={1} flexDirection="column">
            {selectedRun ? (
              <RunDetails run={selectedRun} stateStore={stateStore} />
            ) : null}
          </Box>
        </Box>
      )}

      {snapshot.helpVisible ? <HelpOverlay /> : null}
    </Box>
  );
}

function matchesQuery(run: RunRecord, query: string): boolean {
  const haystack = [
    run.runId,
    run.taskId,
    run.taskTitle,
    run.pr?.id,
    run.phase,
    run.status,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}
