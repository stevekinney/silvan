import { basename } from 'node:path';

import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Config } from '../config/schema';
import type { EventBus } from '../events/bus';
import { writeQueueRequest } from '../state/queue';
import type { StateStore } from '../state/store';
import { needsAttention } from './attention';
import { AttentionQueue } from './components/attention-queue';
import { FilterBar } from './components/filter-bar';
import { FilterPrompt } from './components/filter-prompt';
import { HelpOverlay } from './components/help-overlay';
import { OpenPrsPanel } from './components/open-prs-panel';
import { QueuePanel } from './components/queue-panel';
import { RequestForm } from './components/request-form';
import { RunDetails } from './components/run-details';
import { RunList } from './components/run-list';
import { WorktreePanel } from './components/worktree-panel';
import {
  type FilterKey,
  formatFilterSummary,
  hasActiveFilters,
  matchesFilters,
  parseFilterInput,
} from './filters';
import {
  createRunSnapshotCache,
  type DashboardScope,
  loadQueueRequests,
  loadRunSnapshots,
  loadWorktrees,
  type RunSnapshotCursor,
} from './loader';
import { calculatePageSize } from './pagination';
import { groupRunsByRepo, type SortKey, sortRuns } from './runs';
import { applyDashboardEvent, applyRunSnapshots, createDashboardState } from './state';
import { buildRunSummary } from './summary';
import { formatElapsed } from './time';
import type { DashboardState, RunRecord, WorktreeRecord } from './types';

const EVENT_FLUSH_MS = 120;
const AUTO_REFRESH_MS = 10_000;

const FILTER_PROMPTS: Record<FilterKey, { label: string; hint: string }> = {
  status: {
    label: 'Status filter',
    hint: 'Comma-separated: running, success, failed, canceled, unknown',
  },
  phase: { label: 'Phase filter', hint: 'Comma-separated: plan, implement, verify' },
  convergence: {
    label: 'Convergence filter',
    hint: 'Comma-separated: blocked, waiting_for_ci, waiting_for_review, converged',
  },
  provider: { label: 'Provider filter', hint: 'Comma-separated: github, linear, local' },
  repo: { label: 'Repo filter', hint: 'Comma-separated: owner/repo or path' },
  task: { label: 'Task filter', hint: 'Match task key or title' },
  pr: { label: 'PR filter', hint: 'Match PR id or number' },
};

const FILTER_KEYS: Record<string, FilterKey> = {
  '1': 'status',
  '2': 'phase',
  '3': 'convergence',
  '4': 'provider',
  '5': 'repo',
  '6': 'task',
  '7': 'pr',
};

function createEmptyFilters(): DashboardState['filter'] {
  return {
    query: '',
    status: [],
    phase: [],
    convergence: [],
    provider: [],
    repo: [],
    task: [],
    pr: [],
  };
}
export function Dashboard({
  bus,
  stateStore,
  config,
}: {
  bus: EventBus;
  stateStore: StateStore;
  config: Config;
}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<DashboardState>(createDashboardState);
  const [filterActive, setFilterActive] = useState(false);
  const [filterValue, setFilterValue] = useState('');
  const [filterPrompt, setFilterPrompt] = useState<FilterKey | null>(null);
  const [filterPromptValue, setFilterPromptValue] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [groupByRepo, setGroupByRepo] = useState(true);
  const isGlobalState = basename(stateStore.root) !== '.silvan';
  const [scope, setScope] = useState<DashboardScope>(() =>
    isGlobalState ? 'all' : 'current',
  );
  const effectiveScope = isGlobalState ? scope : 'current';
  const staleAfterDays = config.ui.worktrees.staleAfterDays;
  const staleAfterMs = staleAfterDays * 24 * 60 * 60 * 1000;
  const [sortKey, setSortKey] = useState<SortKey>('updated');
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [detailsView, setDetailsView] = useState(false);
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [artifactView, setArtifactView] = useState(false);
  const [requestActive, setRequestActive] = useState(false);
  const [requestStep, setRequestStep] = useState<'title' | 'description'>('title');
  const [requestTitle, setRequestTitle] = useState('');
  const [requestDescription, setRequestDescription] = useState('');
  const [nextCursor, setNextCursor] = useState<RunSnapshotCursor | null>(null);
  const { stdout } = useStdout();
  const pageSize = useMemo(() => calculatePageSize(stdout?.rows ?? 24), [stdout?.rows]);
  const isNarrow = (stdout?.columns ?? 100) < 100;
  const { exit } = useApp();
  const loaderCache = useRef(createRunSnapshotCache());
  const loadedCountRef = useRef(0);

  const queueRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventQueue = useRef([] as Parameters<typeof applyDashboardEvent>[1][]);

  const refreshDashboard = useCallback(
    async (limit: number): Promise<void> => {
      const [page, queueRequests, worktrees] = await Promise.all([
        loadRunSnapshots(stateStore, {
          limit,
          cache: loaderCache.current,
          scope: effectiveScope,
        }),
        loadQueueRequests(stateStore, {
          cache: loaderCache.current,
          scope: effectiveScope,
        }),
        loadWorktrees(stateStore, {
          cache: loaderCache.current,
          scope: effectiveScope,
        }),
      ]);
      setSnapshot((prev) => {
        const next = applyRunSnapshots(prev, page.runs);
        return { ...next, queueRequests, worktrees };
      });
      setNextCursor(page.nextCursor ?? null);
      loadedCountRef.current = Math.max(loadedCountRef.current, page.runs.length);
      setLastRefreshAt(Date.now());
    },
    [effectiveScope, stateStore],
  );

  const loadMoreRuns = useCallback(async (): Promise<void> => {
    if (!nextCursor) return;
    const page = await loadRunSnapshots(stateStore, {
      limit: pageSize,
      cursor: nextCursor,
      cache: loaderCache.current,
      scope: effectiveScope,
    });
    setSnapshot((prev) => applyRunSnapshots(prev, page.runs));
    setNextCursor(page.nextCursor ?? null);
    loadedCountRef.current += page.runs.length;
    setLastRefreshAt(Date.now());
  }, [effectiveScope, nextCursor, pageSize, stateStore]);

  useEffect(() => {
    loadedCountRef.current = 0;
    setNextCursor(null);
    void refreshDashboard(pageSize);
  }, [pageSize, refreshDashboard]);

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

  useEffect(() => {
    const interval = setInterval(() => {
      void refreshDashboard(Math.max(pageSize, loadedCountRef.current));
    }, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [pageSize, refreshDashboard]);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const allRuns = useMemo(
    () =>
      snapshot.runIndex
        .map((id) => snapshot.runs[id])
        .filter((run): run is RunRecord => Boolean(run)),
    [snapshot],
  );
  const filtersActive = hasActiveFilters(snapshot.filter);
  const summary = useMemo(() => buildRunSummary(allRuns), [allRuns]);
  const filteredRuns = useMemo(
    () => allRuns.filter((run) => matchesFilters(run, snapshot.filter)),
    [allRuns, snapshot.filter],
  );
  const attentionRunsAll = useMemo(
    () => allRuns.filter((run) => needsAttention(run, nowMs)),
    [allRuns, nowMs],
  );
  const attentionRuns = useMemo(
    () => filteredRuns.filter((run) => needsAttention(run, nowMs)),
    [filteredRuns, nowMs],
  );
  const worktreeRows = useMemo(
    () => buildWorktreeRows(snapshot.worktrees, allRuns, nowMs, staleAfterMs),
    [allRuns, nowMs, snapshot.worktrees, staleAfterMs],
  );
  const visibleRuns = attentionOnly ? attentionRuns : filteredRuns;
  const { runs: orderedRuns, repoCounts } = useMemo(() => {
    if (groupByRepo) {
      return groupRunsByRepo(visibleRuns, sortKey, nowMs);
    }
    return { runs: sortRuns(visibleRuns, sortKey, nowMs), repoCounts: new Map() };
  }, [groupByRepo, nowMs, sortKey, visibleRuns]);

  const selectedRunId =
    orderedRuns.find((run) => run.runId === snapshot.selection)?.runId ??
    orderedRuns[0]?.runId;
  const selectedRun = selectedRunId
    ? orderedRuns.find((run) => run.runId === selectedRunId)
    : undefined;

  useInput((input, key) => {
    if (artifactView) {
      if (input === 'q') {
        exit();
      }
      return;
    }
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
    if (filterPrompt) {
      if (key.escape) {
        setFilterPrompt(null);
        setFilterPromptValue('');
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
    if (input === 'a') {
      setAttentionOnly((prev) => !prev);
      return;
    }
    if (input === 'g') {
      if (isGlobalState) {
        setScope((prev) => (prev === 'all' ? 'current' : 'all'));
      }
      return;
    }
    if (input === 'p') {
      setGroupByRepo((prev) => !prev);
      return;
    }
    if (input === 's') {
      setSortKey((prev) => cycleSort(prev));
      return;
    }
    if (input === 'c') {
      clearFilters();
      return;
    }
    if (input === 'v') {
      if (isNarrow && !detailsView) {
        setDetailsView(true);
      }
      setArtifactView((prev) => !prev);
      return;
    }
    if (input === 't') {
      setStepsExpanded((prev) => !prev);
      return;
    }
    const filterKey = FILTER_KEYS[input];
    if (filterKey) {
      openFilterPrompt(filterKey);
      return;
    }
    if (input === 'r') {
      const limit = Math.max(pageSize, loadedCountRef.current);
      void refreshDashboard(limit);
      return;
    }
    if (input === 'l') {
      void loadMoreRuns();
      return;
    }
    if (input === 'b') {
      setDetailsView(false);
      setArtifactView(false);
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

  function openFilterPrompt(key: FilterKey) {
    const current = snapshot.filter[key].join(', ');
    setFilterPrompt(key);
    setFilterPromptValue(current);
  }

  function applyFilterPrompt(): void {
    if (!filterPrompt) return;
    const values = parseFilterInput(filterPromptValue);
    setSnapshot((prev) => ({
      ...prev,
      filter: { ...prev.filter, [filterPrompt]: values },
    }));
    setFilterPrompt(null);
    setFilterPromptValue('');
  }

  function clearFilters(): void {
    setSnapshot((prev) => ({
      ...prev,
      filter: createEmptyFilters(),
    }));
    setFilterValue('');
  }

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
    if (orderedRuns.length === 0) return;
    const index = orderedRuns.findIndex((run) => run.runId === selectedRunId);
    const nextIndex = Math.min(Math.max(index + delta, 0), orderedRuns.length - 1);
    const nextRunId = orderedRuns[nextIndex]?.runId;
    if (nextRunId) {
      setSnapshot((prev) => ({ ...prev, selection: nextRunId }));
    }
  }

  const refreshAge =
    lastRefreshAt !== null ? `${formatElapsed(nowMs - lastRefreshAt)} ago` : '...';
  const attentionQueueRuns = filtersActive ? attentionRuns : attentionRunsAll;
  const sortLabel = formatSortLabel(sortKey);
  const phaseSummary = formatCountMap(summary.phase);
  const convergenceSummary = formatCountMap(summary.convergence);
  const scopeLabel = effectiveScope === 'all' ? 'All Repos' : 'Current Repo';

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>Silvan Mission Control</Text>
        <Text color="gray">
          Scope: {scopeLabel}
          {isGlobalState ? ' • g scope' : ''}
          {` • Refreshed ${refreshAge} • / search • ? help`}
          {nextCursor ? ' • l load more' : ''}
        </Text>
      </Box>

      {filtersActive ? (
        <Text color="yellow">
          Filters: {formatFilterSummary(snapshot.filter)} • c clear
        </Text>
      ) : null}

      {filterActive ? (
        <FilterBar
          query={filterValue}
          onChange={setFilterValue}
          onSubmit={() => {
            setSnapshot((prev) => ({
              ...prev,
              filter: { ...prev.filter, query: filterValue },
            }));
            setFilterActive(false);
          }}
        />
      ) : null}

      {filterPrompt ? (
        <FilterPrompt
          label={FILTER_PROMPTS[filterPrompt].label}
          hint={FILTER_PROMPTS[filterPrompt].hint}
          value={filterPromptValue}
          onChange={setFilterPromptValue}
          onSubmit={applyFilterPrompt}
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

      {allRuns.length > 0 ? (
        <Box flexDirection="column">
          <Text color="gray">Summary</Text>
          <Box flexDirection="row" gap={2}>
            <Text color="cyan">{summary.status.running} Running</Text>
            <Text color="yellow">{summary.status.blocked} Blocked</Text>
            <Text color="red">{summary.status.failed} Failed</Text>
            <Text color="green">{summary.status.success} Success</Text>
            <Text color="gray">{summary.total} Total</Text>
          </Box>
          {phaseSummary ? <Text color="gray">Phases: {phaseSummary}</Text> : null}
          {convergenceSummary ? (
            <Text color="gray">Convergence: {convergenceSummary}</Text>
          ) : null}
        </Box>
      ) : null}

      {attentionQueueRuns.length > 0 && !attentionOnly && allRuns.length > 0 ? (
        <AttentionQueue runs={attentionQueueRuns} nowMs={nowMs} />
      ) : null}

      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          {attentionOnly ? 'Attention' : 'Runs'} ({visibleRuns.length}
          {filtersActive && !attentionOnly ? ` of ${summary.total}` : ''})
        </Text>
        <Text color="gray">
          Sort: {sortLabel} • Group: {groupByRepo ? 'On' : 'Off'} (p) • a{' '}
          {attentionOnly ? 'all' : 'attention'}
        </Text>
      </Box>

      {filtersActive ? (
        <Text color="gray">
          Showing {visibleRuns.length} of {summary.total} runs
        </Text>
      ) : null}

      {visibleRuns.length === 0 ? (
        <Text color="gray">
          {allRuns.length === 0
            ? 'No runs yet. Press n to queue a task, then run `silvan queue run`.'
            : 'No runs match the current filters.'}
        </Text>
      ) : isNarrow ? (
        detailsView && selectedRun ? (
          <RunDetails
            run={selectedRun}
            stateStore={stateStore}
            nowMs={nowMs}
            stepsExpanded={stepsExpanded}
            artifactView={artifactView}
            onCloseArtifacts={() => setArtifactView(false)}
          />
        ) : (
          <RunList
            runs={orderedRuns}
            {...(selectedRunId ? { selectedRunId } : {})}
            groupByRepo={groupByRepo}
            repoCounts={repoCounts}
            nowMs={nowMs}
          />
        )
      ) : (
        <Box flexDirection="row" gap={4}>
          <Box width={40} flexDirection="column">
            <RunList
              runs={orderedRuns}
              {...(selectedRunId ? { selectedRunId } : {})}
              groupByRepo={groupByRepo}
              repoCounts={repoCounts}
              nowMs={nowMs}
            />
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Open PRs</Text>
              <OpenPrsPanel prs={snapshot.openPrs} />
            </Box>
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Queue ({snapshot.queueRequests.length} pending)</Text>
              <QueuePanel requests={snapshot.queueRequests} nowMs={nowMs} />
            </Box>
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Worktrees ({worktreeRows.length})</Text>
              <WorktreePanel worktrees={worktreeRows} nowMs={nowMs} />
            </Box>
          </Box>
          <Box flexGrow={1} flexDirection="column">
            {selectedRun ? (
              <RunDetails
                run={selectedRun}
                stateStore={stateStore}
                nowMs={nowMs}
                stepsExpanded={stepsExpanded}
                artifactView={artifactView}
                onCloseArtifacts={() => setArtifactView(false)}
              />
            ) : null}
          </Box>
        </Box>
      )}

      {snapshot.helpVisible ? <HelpOverlay /> : null}
    </Box>
  );
}

function formatCountMap(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key}(${count})`)
    .join(' ');
}

function formatSortLabel(sortKey: SortKey): string {
  switch (sortKey) {
    case 'started':
      return 'Started';
    case 'duration':
      return 'Duration';
    case 'updated':
    default:
      return 'Updated';
  }
}

function cycleSort(current: SortKey): SortKey {
  const order: SortKey[] = ['updated', 'started', 'duration'];
  const index = order.indexOf(current);
  return order[(index + 1) % order.length] ?? 'updated';
}

type WorktreeView = WorktreeRecord & {
  repoLabel: string;
  run?: RunRecord;
  isStale: boolean;
  isOrphaned: boolean;
  activityMs?: number;
};

function buildWorktreeRows(
  worktrees: WorktreeRecord[],
  runs: RunRecord[],
  nowMs: number,
  staleAfterMs: number,
): WorktreeView[] {
  if (worktrees.length === 0) return [];
  const byPath = new Map<string, RunRecord>();
  const byBranch = new Map<string, RunRecord>();

  for (const run of runs) {
    const runStamp = resolveRunTimestamp(run);
    if (run.worktree?.path) {
      const existing = byPath.get(run.worktree.path);
      if (!existing || resolveRunTimestamp(existing) < runStamp) {
        byPath.set(run.worktree.path, run);
      }
    }
    if (run.pr?.headBranch) {
      const existing = byBranch.get(run.pr.headBranch);
      if (!existing || resolveRunTimestamp(existing) < runStamp) {
        byBranch.set(run.pr.headBranch, run);
      }
    }
  }

  const rows = worktrees.map((worktree) => {
    const repoLabel = worktree.repoLabel ?? worktree.repoId ?? 'current';
    const run =
      (worktree.path ? byPath.get(worktree.path) : undefined) ??
      (worktree.branch ? byBranch.get(worktree.branch) : undefined);
    const activityMs = resolveActivityMs(worktree, run);
    const isOrphaned = !run;
    const isStale =
      typeof activityMs === 'number' ? nowMs - activityMs > staleAfterMs : false;
    return {
      ...worktree,
      repoLabel,
      isOrphaned,
      isStale,
      ...(run ? { run } : {}),
      ...(typeof activityMs === 'number' ? { activityMs } : {}),
    };
  });

  return rows.sort((a, b) => {
    if (a.repoLabel !== b.repoLabel) {
      return a.repoLabel.localeCompare(b.repoLabel);
    }
    return compareWorktreePriority(a, b);
  });
}

function resolveRunTimestamp(run: RunRecord): number {
  const stamp = run.latestEventAt ?? run.updatedAt;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveActivityMs(
  worktree: WorktreeRecord,
  run: RunRecord | undefined,
): number | undefined {
  const worktreeTs = worktree.lastActivityAt ? Date.parse(worktree.lastActivityAt) : NaN;
  const runTs = run ? resolveRunTimestamp(run) : NaN;
  const hasWorktree = Number.isFinite(worktreeTs);
  const hasRun = Number.isFinite(runTs);
  if (hasWorktree && hasRun) {
    return Math.max(worktreeTs, runTs);
  }
  if (hasWorktree) return worktreeTs;
  if (hasRun) return runTs;
  return undefined;
}

function compareWorktreePriority(a: WorktreeView, b: WorktreeView): number {
  const dirtyRank = (worktree: WorktreeView) => (worktree.isDirty ? 0 : 1);
  const lockedRank = (worktree: WorktreeView) => (worktree.isLocked ? 0 : 1);
  const staleRank = (worktree: WorktreeView) =>
    worktree.isStale || worktree.isOrphaned ? 1 : 0;
  const activityRank = (worktree: WorktreeView) => {
    if (typeof worktree.activityMs !== 'number') return 0;
    return -worktree.activityMs;
  };

  const ranks: Array<(worktree: WorktreeView) => number> = [
    dirtyRank,
    lockedRank,
    staleRank,
    activityRank,
  ];
  for (const rank of ranks) {
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
  }
  return a.path.localeCompare(b.path);
}
