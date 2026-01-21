import chalk from 'chalk';

import { stripAnsi, truncateText } from '../utils/text';

export const DEFAULT_LINE_WIDTH = 60;
export const DEFAULT_LABEL_WIDTH = 14;

type SemanticColor =
  | 'success'
  | 'warning'
  | 'error'
  | 'running'
  | 'info'
  | 'dim'
  | 'header';

const statusColors: Record<string, SemanticColor> = {
  running: 'running',
  blocked: 'warning',
  success: 'success',
  failed: 'error',
  canceled: 'warning',
  aborted: 'warning',
  clean: 'success',
  dirty: 'warning',
  locked: 'warning',
  bare: 'info',
  detached: 'warning',
  unknown: 'dim',
};

const isTty = (): boolean => Boolean(process.stdout.isTTY);

export const colors = {
  success: (text: string): string => (isTty() ? chalk.green(text) : text),
  warning: (text: string): string => (isTty() ? chalk.yellow(text) : text),
  error: (text: string): string => (isTty() ? chalk.red(text) : text),
  running: (text: string): string => (isTty() ? chalk.cyan(text) : text),
  info: (text: string): string => (isTty() ? chalk.blue(text) : text),
  dim: (text: string): string => (isTty() ? chalk.gray(text) : text),
  header: (text: string): string => (isTty() ? chalk.bold(text) : text),
};

export function divider(
  kind: 'major' | 'minor' = 'minor',
  width = DEFAULT_LINE_WIDTH,
): string {
  const char = kind === 'major' ? '=' : '-';
  return char.repeat(width);
}

export function padAnsi(value: string, width: number): string {
  const visibleLength = stripAnsi(value).length;
  if (visibleLength >= width) return value;
  return `${value}${' '.repeat(width - visibleLength)}`;
}

export { truncateText };

export function getTerminalWidth(fallback = 80): number {
  const columns = process.stdout.columns;
  if (typeof columns === 'number' && Number.isFinite(columns) && columns > 0) {
    return columns;
  }
  return fallback;
}

export function renderSectionHeader(
  title: string,
  options?: { width?: number; kind?: 'major' | 'minor'; color?: boolean },
): string {
  const width = options?.width ?? DEFAULT_LINE_WIDTH;
  const kind = options?.kind ?? 'minor';
  const header = options?.color === false ? title : colors.header(title);
  return `${header}\n${divider(kind, width)}`;
}

export function padLabel(label: string, width = DEFAULT_LABEL_WIDTH): string {
  return label.padEnd(width);
}

export function formatKeyValues(
  entries: Array<[string, string]>,
  options?: { labelWidth?: number; indent?: number },
): string[] {
  const labelWidth = options?.labelWidth ?? DEFAULT_LABEL_WIDTH;
  const indent = options?.indent ?? 0;
  const pad = ' '.repeat(indent);
  return entries.map(([label, value]) => `${pad}${padLabel(label, labelWidth)} ${value}`);
}

export function formatKeyList(
  label: string,
  summary: string,
  items: string[],
  options?: { labelWidth?: number; indent?: number; bullet?: string },
): string[] {
  const labelWidth = options?.labelWidth ?? DEFAULT_LABEL_WIDTH;
  const indent = options?.indent ?? 0;
  const bullet = options?.bullet ?? '-';
  const pad = ' '.repeat(indent);
  const lines = [`${pad}${padLabel(label, labelWidth)} ${summary}`];
  for (const item of items) {
    lines.push(`${pad}${' '.repeat(labelWidth)} ${bullet} ${item}`);
  }
  return lines;
}

export function renderNextSteps(steps: string[], options?: { indent?: number }): string {
  if (steps.length === 0) return '';
  const indent = options?.indent ?? 0;
  const pad = ' '.repeat(indent);
  return ['', `${pad}Next steps:`, ...steps.map((step) => `${pad}  ${step}`)].join('\n');
}

export function formatStatusLabel(status: string): string {
  const normalized = status.trim().toLowerCase();
  const label = toTitleCase(normalized.replace(/_/g, ' '));
  const color = statusColors[normalized] ?? 'info';
  return colors[color](label);
}

export function renderSuccessSummary(options: {
  title: string;
  details?: Array<[string, string]>;
  nextSteps?: string[];
  width?: number;
  labelWidth?: number;
}): string {
  const lines: string[] = [];
  lines.push(
    renderSectionHeader(options.title, {
      width: options.width ?? DEFAULT_LINE_WIDTH,
      kind: 'minor',
    }),
  );
  if (options.details && options.details.length > 0) {
    lines.push(
      ...formatKeyValues(options.details, {
        labelWidth: options.labelWidth ?? DEFAULT_LABEL_WIDTH,
      }),
    );
  }
  if (options.nextSteps && options.nextSteps.length > 0) {
    lines.push(renderNextSteps(options.nextSteps));
  }
  return lines.join('\n');
}

function toTitleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
