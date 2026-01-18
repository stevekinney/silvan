import {
  colors,
  divider,
  formatStatusLabel,
  getTerminalWidth,
  padAnsi,
  truncateText,
} from './output';

export type RunListEntry = {
  runId: string;
  status: string;
  phase: string;
  taskTitle?: string;
  taskKey?: string;
  taskProvider?: string;
  updatedAt?: string;
  startedAt?: string;
  prUrl?: string;
  convergence?: { status: string; reason?: string };
};

export type RunListRenderOptions = {
  total: number;
  filteredTotal: number;
  showing: number;
  limit: number;
  offset: number;
  showSource: boolean;
  filters?: {
    status?: string[];
    phase?: string[];
    source?: string[];
  };
};

export function renderRunListTable(
  runs: RunListEntry[],
  options: RunListRenderOptions,
): string {
  if (runs.length === 0) {
    return renderRunListEmpty(options);
  }

  const title = buildRunListTitle(options);
  const showSource = options.showSource;
  const now = Date.now();
  const maxTaskWidth = getTaskWidth(getTerminalWidth());
  const headers = [
    'ID',
    'Status',
    'Phase',
    ...(showSource ? ['Source'] : []),
    'Task',
    'Updated',
  ];

  const rows = runs.map((run) => {
    const id = shortRunId(run.runId);
    const statusLabel = normalizeStatus(run.status);
    const statusDisplay = formatStatusLabel(statusLabel);
    const phase = run.phase || 'unknown';
    const source = showSource ? formatSourceLabel(run) : undefined;
    const taskTitle = run.taskTitle?.trim() || 'Untitled';
    const updated = formatRelativeTime(run.updatedAt, now);
    const truncatedTask = truncateText(taskTitle, maxTaskWidth);

    return {
      raw: [
        id,
        toTitleCase(statusLabel),
        phase,
        ...(showSource ? [source ?? 'unknown'] : []),
        truncatedTask,
        updated,
      ],
      display: [
        colors.dim(id),
        statusDisplay,
        phase,
        ...(showSource ? [source ?? 'unknown'] : []),
        truncatedTask,
        colors.dim(updated),
      ],
    };
  });

  const widths = headers.map((header, index) => {
    const rawValues = rows.map((row) => row.raw[index] ?? '');
    const contentWidth = Math.max(...rawValues.map((value) => value.length), 0);
    if (header === 'Task') {
      return Math.max(maxTaskWidth, header.length);
    }
    return Math.max(header.length, contentWidth);
  });

  const tableWidth =
    widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * 2;
  const lines: string[] = [];

  lines.push(title);
  lines.push(divider('major', Math.max(tableWidth, title.length)));
  lines.push(renderRow(headers, widths));
  lines.push(divider('minor', Math.max(tableWidth, title.length)));

  for (const row of rows) {
    lines.push(renderRow(row.display, widths));
  }

  lines.push(divider('minor', Math.max(tableWidth, title.length)));
  lines.push(`Legend: Running, Blocked, Success, Failed`);

  const footer = buildRunListFooter(options, runs[0]?.runId);
  if (footer.length > 0) {
    lines.push('');
    lines.push(...footer);
  }

  return lines.join('\n');
}

export function renderRunListMinimal(runs: RunListEntry[]): string {
  return runs
    .map((run) => {
      const id = shortRunId(run.runId);
      const status = normalizeStatus(run.status);
      const phase = run.phase || 'unknown';
      const taskTitle = run.taskTitle?.trim() || 'Untitled';
      return `${id} ${status} ${phase} ${taskTitle}`;
    })
    .join('\n');
}

export function formatRelativeTime(
  value: string | undefined,
  nowMs = Date.now(),
): string {
  if (!value) return 'unknown';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'unknown';
  const diffMs = Math.max(0, nowMs - parsed);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;

  if (diffMs < minute) return 'just now';
  if (diffMs < hour) {
    const mins = Math.round(diffMs / minute);
    return `${mins} min ago`;
  }
  if (diffMs < day) {
    const hours = Math.round(diffMs / hour);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(diffMs / day);
  if (days < 7) {
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return new Date(parsed).toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

function renderRow(values: string[], widths: number[]): string {
  const padded = values.map((value, index) => padAnsi(value, widths[index] ?? 0));
  return padded.join('  ');
}

function buildRunListTitle(options: RunListRenderOptions): string {
  const hasFilters = Boolean(
    options.filters?.status?.length ||
    options.filters?.phase?.length ||
    options.filters?.source?.length,
  );
  const statusFilter = options.filters?.status;
  const singleStatus = statusFilter?.length === 1 ? statusFilter[0] : undefined;
  const statusTitle = singleStatus ? `${toTitleCase(singleStatus)} Runs` : 'Runs';
  const baseTitle = hasFilters ? statusTitle : 'Runs';

  const countParts: string[] = [];
  if (hasFilters && options.filteredTotal !== options.total) {
    countParts.push(`${options.filteredTotal} of ${options.total}`);
  } else {
    countParts.push(`${options.total} total`);
  }
  if (options.showing !== options.filteredTotal) {
    countParts.push(`showing ${options.showing}`);
  }
  return `${baseTitle} (${countParts.join(', ')})`;
}

function buildRunListFooter(
  options: RunListRenderOptions,
  runId: string | undefined,
): string[] {
  const lines: string[] = [];
  if (options.filteredTotal > options.showing) {
    lines.push(`Show more: silvan run list --limit ${options.limit + options.showing}`);
  }
  if (!options.filters?.status?.length) {
    lines.push('Filter: silvan run list --status blocked');
  }
  if (runId) {
    lines.push(`Details: silvan run inspect ${runId}`);
  }
  return lines;
}

function renderRunListEmpty(options: RunListRenderOptions): string {
  const title = buildRunListTitle(options);
  const lines: string[] = [];
  lines.push(title);
  lines.push(divider('major', Math.max(title.length, 30)));
  lines.push('No runs found.');
  lines.push('');
  lines.push('Start a task:');
  lines.push('  silvan task start "Your task"');
  lines.push('  silvan task start gh-42');
  return lines.join('\n');
}

function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

function normalizeStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'waiting_for_ci' || normalized === 'waiting_for_review') {
    return 'blocked';
  }
  if (normalized === 'waiting_for_user') {
    return 'blocked';
  }
  if (normalized === 'converged') {
    return 'success';
  }
  if (normalized === 'aborted') {
    return 'canceled';
  }
  return normalized || 'unknown';
}

function formatSourceLabel(run: RunListEntry): string {
  if (run.taskKey) return run.taskKey;
  if (run.taskProvider === 'github') return 'GitHub';
  if (run.taskProvider === 'linear') return 'Linear';
  if (run.taskProvider === 'local') return 'Local';
  return 'Unknown';
}

function getTaskWidth(terminalWidth: number): number {
  if (terminalWidth >= 120) return 60;
  if (terminalWidth >= 80) return 40;
  return 25;
}

function toTitleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
