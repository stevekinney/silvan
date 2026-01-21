import {
  colors,
  divider,
  formatStatusLabel,
  getTerminalWidth,
  padAnsi,
  truncateText,
} from './output';

export type WorktreeListEntry = {
  path: string;
  branch?: string;
  headSha?: string;
  isBare?: boolean;
  isLocked?: boolean;
  isDirty?: boolean;
};

export type WorktreeListRenderOptions = {
  total: number;
};

export function renderWorktreeListTable(
  worktrees: WorktreeListEntry[],
  options: WorktreeListRenderOptions,
): string {
  if (worktrees.length === 0) {
    return renderWorktreeListEmpty(options);
  }

  const title = buildWorktreeListTitle(options);
  const terminalWidth = getTerminalWidth();
  const branchWidth = Math.max('Branch'.length, getBranchWidth(terminalWidth));
  const pathWidth = Math.max('Path'.length, getPathWidth(terminalWidth));

  const headers = ['Status', 'Branch', 'Path', 'Head'];
  const rows = worktrees.map((worktree) => {
    const status = deriveWorktreeStatus(worktree);
    const statusLabel = toTitleCase(status);
    const branch = truncateText(formatBranchLabel(worktree), branchWidth);
    const path = truncateText(worktree.path, pathWidth);
    const head = shortSha(worktree.headSha);

    return {
      raw: [statusLabel, branch, path, head],
      display: [formatStatusLabel(status), branch, path, colors.dim(head)],
    };
  });

  const widths = headers.map((header, index) => {
    const rawValues = rows.map((row) => row.raw[index] ?? '');
    const contentWidth = Math.max(...rawValues.map((value) => value.length), 0);
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
  lines.push('Legend: Clean, Dirty, Locked, Bare, Detached');

  return lines.join('\n');
}

export function deriveWorktreeStatus(worktree: WorktreeListEntry): string {
  if (worktree.isLocked) return 'locked';
  if (worktree.isBare) return 'bare';
  if (worktree.isDirty) return 'dirty';
  if (!worktree.branch) return 'detached';
  return 'clean';
}

function renderWorktreeListEmpty(options: WorktreeListRenderOptions): string {
  const title = buildWorktreeListTitle(options);
  const lines: string[] = [];
  lines.push(title);
  lines.push(divider('major', Math.max(title.length, 30)));
  lines.push('No worktrees found.');
  return lines.join('\n');
}

function buildWorktreeListTitle(options: WorktreeListRenderOptions): string {
  return `Worktrees (${options.total} total)`;
}

function renderRow(values: string[], widths: number[]): string {
  const padded = values.map((value, index) => padAnsi(value, widths[index] ?? 0));
  return padded.join('  ');
}

function formatBranchLabel(worktree: WorktreeListEntry): string {
  if (worktree.isBare) return 'bare';
  if (worktree.branch) return worktree.branch;
  return 'detached';
}

function shortSha(value?: string): string {
  if (!value) return 'unknown';
  return value.slice(0, 8);
}

function getBranchWidth(terminalWidth: number): number {
  if (terminalWidth >= 140) return 28;
  if (terminalWidth >= 120) return 24;
  if (terminalWidth >= 100) return 22;
  if (terminalWidth >= 80) return 18;
  return 16;
}

function getPathWidth(terminalWidth: number): number {
  if (terminalWidth >= 140) return 70;
  if (terminalWidth >= 120) return 60;
  if (terminalWidth >= 100) return 50;
  if (terminalWidth >= 80) return 40;
  return 25;
}

function toTitleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
