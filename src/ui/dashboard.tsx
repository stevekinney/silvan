import { basename } from 'node:path';

import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Config } from '../config/schema';
import type { EventBus } from '../events/bus';
import type { StateStore } from '../state/store';
import { truncateText } from '../utils/text';
import { needsAttention } from './attention';
import { AttentionQueue } from './components/attention-queue';
import { FilterBar } from './components/filter-bar';
import { FilterPrompt } from './components/filter-prompt';
import { HelpOverlay } from './components/help-overlay';
import { OpenPrsPanel } from './components/open-prs-panel';
import { QueuePanel } from './components/queue-panel';
import { RequestForm } from './components/request-form';
import { RunDetails } from './components/run-details';
import { RunDetailsCompact } from './components/run-details-compact';
import { RunListCompact } from './components/run-list-compact';
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
import { enqueueQueueRequest } from './queue-requests';
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
  const [dimensions, setDimensions] = useState(() => ({
    rows: stdout?.rows ?? 24,
    columns: stdout?.columns ?? 100,
  }));
  useEffect(() => {
    if (!stdout || typeof stdout.on !== 'function') return;
    const update = () =>
      setDimensions({
        rows: stdout.rows ?? 24,
        columns: stdout.columns ?? 100,
      });
    update();
    stdout.on('resize', update);
    return () => {
      stdout.removeListener('resize', update);
    };
  }, [stdout]);
  const rows = dimensions.rows;
  const columns = dimensions.columns;
  const layout = useMemo(() => buildLayout(rows, columns), [rows, columns]);
  const pageSize = useMemo(
    () =>
      calculatePageSize(rows, {
        headerHeight: layout.headerHeight,
        footerHeight: layout.bottomHeight,
        min: layout.minMainHeight,
      }),
    [layout.bottomHeight, layout.headerHeight, layout.minMainHeight, rows],
  );
  const bottomItems = useMemo(
    () => Math.max(0, layout.bottomHeight - 1),
    [layout.bottomHeight],
  );
  const worktreeLimit = bottomItems;
  const isNarrow = layout.isNarrow;
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
  const { runs: orderedRuns } = useMemo(() => {
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
    const queueRequests = await enqueueQueueRequest({
      state: stateStore,
      cache: loaderCache.current,
      scope: effectiveScope,
      title,
      description: requestDescription,
    });
    setSnapshot((prev) => ({ ...prev, queueRequests }));
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
  const attentionLayout = useMemo(
    () =>
      buildAttentionLayout(attentionQueueRuns.length, {
        availableHeight: layout.availableHeight,
        minMainHeight: layout.minMainHeight,
        attentionOnly,
      }),
    [
      attentionOnly,
      attentionQueueRuns.length,
      layout.availableHeight,
      layout.minMainHeight,
    ],
  );
  const mainHeight = Math.max(1, layout.availableHeight - attentionLayout.height);
  const sortLabel = formatSortLabel(sortKey);
  const scopeLabel = effectiveScope === 'all' ? 'All Repos' : 'Current Repo';
  const filterLine = filtersActive
    ? `Filters: ${formatFilterSummary(snapshot.filter)}`
    : 'Filters: none';
  const summaryLine =
    allRuns.length > 0
      ? `${summary.status.running} run • ${summary.status.blocked} blocked • ${summary.status.failed} failed • ${summary.status.success} success • ${summary.total} total`
      : 'No runs yet. Press n to queue a task.';
  const headerLine = buildHeaderLine(
    layout.columns,
    'Silvan Mission Control',
    `Scope: ${scopeLabel}${isGlobalState ? ' • g scope' : ''} • Refreshed ${refreshAge} • / filter • ? help`,
  );
  const summaryText = truncateText(summaryLine, layout.columns);
  const filterText = truncateText(
    `${filterLine} • Sort: ${sortLabel} • Group: ${groupByRepo ? 'On' : 'Off'}`,
    layout.columns,
  );

  const modal =
    filterActive || filterPrompt || requestActive ? (
      <Box flexDirection="column">
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
      </Box>
    ) : null;

  const runListSelectionProps = selectedRunId ? { selectedRunId } : {};
  const mainContent =
    modal ??
    (isNarrow ? (
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
        <RunListCompact
          runs={orderedRuns}
          nowMs={nowMs}
          width={layout.columns}
          maxRows={mainHeight}
          groupByRepo={groupByRepo}
          {...runListSelectionProps}
        />
      )
    ) : (
      <Box flexDirection="row" height={mainHeight}>
        <Box width={layout.leftWidth} flexDirection="column">
          <RunListCompact
            runs={orderedRuns}
            nowMs={nowMs}
            width={layout.leftWidth}
            maxRows={mainHeight}
            groupByRepo={groupByRepo}
            {...runListSelectionProps}
          />
        </Box>
        <Box width={1} flexDirection="column">
          <Text color="gray">|</Text>
        </Box>
        <Box width={layout.rightWidth} flexDirection="column">
          {selectedRun ? (
            <RunDetailsCompact
              run={selectedRun}
              nowMs={nowMs}
              width={layout.rightWidth}
              maxRows={mainHeight}
            />
          ) : (
            <Text color="gray">Select a run to view details.</Text>
          )}
        </Box>
      </Box>
    ));

  return (
    <Box flexDirection="column" height={layout.rows}>
      <Text>{headerLine}</Text>
      {layout.showSummaryLine ? <Text color="gray">{summaryText}</Text> : null}
      {layout.showFilterLine ? (
        <Text color={filtersActive ? 'yellow' : 'gray'}>{filterText}</Text>
      ) : null}

      {attentionLayout.show ? (
        <AttentionQueue
          runs={attentionQueueRuns}
          nowMs={nowMs}
          compact
          maxItems={attentionLayout.maxItems}
          maxWidth={layout.columns}
        />
      ) : null}

      <Box flexDirection="column" height={mainHeight}>
        {mainContent}
      </Box>

      {!modal && layout.showBottom ? (
        <Box flexDirection="column" height={layout.bottomHeight}>
          <Text color="gray">
            {truncateText(
              `PRs | Queue (${snapshot.queueRequests.length}) | Worktrees (${worktreeRows.length})`,
              layout.columns,
            )}
          </Text>
          <Box flexDirection="row">
            <Box width={layout.columnWidth} flexDirection="column">
              <OpenPrsPanel
                prs={snapshot.openPrs}
                compact
                maxItems={bottomItems}
                maxWidth={layout.columnWidth}
              />
            </Box>
            <Box width={1} flexDirection="column">
              <Text color="gray">|</Text>
            </Box>
            <Box width={layout.columnWidth} flexDirection="column">
              <QueuePanel
                requests={snapshot.queueRequests}
                nowMs={nowMs}
                compact
                maxItems={bottomItems}
                maxWidth={layout.columnWidth}
              />
            </Box>
            <Box width={1} flexDirection="column">
              <Text color="gray">|</Text>
            </Box>
            <Box width={layout.columnWidth} flexDirection="column">
              <WorktreePanel
                worktrees={worktreeRows}
                nowMs={nowMs}
                maxItems={worktreeLimit}
                totalCount={worktreeRows.length}
                compact
                maxWidth={layout.columnWidth}
              />
            </Box>
          </Box>
        </Box>
      ) : null}

      {snapshot.helpVisible ? <HelpOverlay /> : null}
    </Box>
  );
}

function buildLayout(
  rows: number,
  columns: number,
): {
  rows: number;
  columns: number;
  headerHeight: number;
  footerHeight: number;
  bottomHeight: number;
  availableHeight: number;
  minMainHeight: number;
  leftWidth: number;
  rightWidth: number;
  columnWidth: number;
  isNarrow: boolean;
  showSummaryLine: boolean;
  showFilterLine: boolean;
  showBottom: boolean;
} {
  const safeRows = Math.max(1, rows);
  const safeColumns = Math.max(1, columns);
  const showSummaryLine = safeRows >= 10;
  const showFilterLine = safeRows >= 16;
  const headerHeight = 1 + (showSummaryLine ? 1 : 0) + (showFilterLine ? 1 : 0);
  const footerHeight = 0;
  const minMainHeight = 6;
  const wantsBottom = safeRows >= 22;
  const preferredBottom = safeRows >= 30 ? 6 : 4;
  const maxBottom = Math.max(0, safeRows - headerHeight - footerHeight - minMainHeight);
  let bottomHeight = wantsBottom ? Math.min(preferredBottom, maxBottom) : 0;
  const showBottom = bottomHeight >= 2 && safeColumns >= 60;
  if (!showBottom) bottomHeight = 0;
  const availableHeight = Math.max(
    1,
    safeRows - headerHeight - footerHeight - bottomHeight,
  );
  const minSplitWidth = 28 + 30 + 1;
  const isNarrow = safeColumns < 100 || safeRows < 24 || safeColumns < minSplitWidth;
  let leftWidth = safeColumns;
  let rightWidth = safeColumns;
  if (!isNarrow) {
    const availableWidth = Math.max(1, safeColumns - 1);
    const desiredLeft = Math.floor(safeColumns * 0.45);
    leftWidth = clamp(desiredLeft, 28, Math.max(28, availableWidth - 30));
    rightWidth = Math.max(30, availableWidth - leftWidth);
  }
  const columnWidth = Math.max(1, Math.floor((safeColumns - 2) / 3));
  return {
    rows: safeRows,
    columns: safeColumns,
    headerHeight,
    footerHeight,
    bottomHeight,
    availableHeight,
    minMainHeight,
    leftWidth,
    rightWidth,
    columnWidth,
    isNarrow,
    showSummaryLine,
    showFilterLine,
    showBottom,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function buildAttentionLayout(
  attentionCount: number,
  options: {
    availableHeight: number;
    minMainHeight: number;
    attentionOnly: boolean;
  },
): { show: boolean; maxItems: number; height: number } {
  if (attentionCount <= 0 || options.attentionOnly) {
    return { show: false, maxItems: 0, height: 0 };
  }
  const budget = Math.max(0, options.availableHeight - options.minMainHeight);
  if (budget < 2) {
    return { show: false, maxItems: 0, height: 0 };
  }
  const maxItems = Math.max(1, Math.min(attentionCount, budget - 1));
  return { show: maxItems > 0, maxItems, height: maxItems + 1 };
}

function buildHeaderLine(columns: number, left: string, right: string): string {
  const safeColumns = Math.max(1, columns);
  const gap = safeColumns - left.length - right.length;
  if (gap <= 1) {
    return truncateText(`${left} ${right}`, safeColumns);
  }
  return `${left}${' '.repeat(gap)}${right}`;
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
