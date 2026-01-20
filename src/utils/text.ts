const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export function truncateText(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return '.'.repeat(maxLength);
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function truncateLines(
  value: string,
  options?: { maxLines?: number; maxChars?: number; stripAnsi?: boolean },
): { lines: string[]; truncated: boolean } {
  const maxLines = options?.maxLines ?? 12;
  const maxChars = options?.maxChars ?? 2000;
  const raw = options?.stripAnsi === false ? value : stripAnsi(value);
  const sliced = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  const lines = sliced.split(/\r?\n/);
  const truncated = raw.length > maxChars || lines.length > maxLines;
  return {
    lines: lines.slice(0, maxLines),
    truncated,
  };
}
