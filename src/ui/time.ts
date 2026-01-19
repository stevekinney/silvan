export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatRelativeTime(
  value: string | undefined,
  nowMs = Date.now(),
): string {
  if (!value) return 'unknown';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'unknown';
  const diff = Math.max(0, nowMs - parsed);
  return formatElapsed(diff);
}

export function formatTimestamp(value: string | undefined): string {
  if (!value) return 'unknown';
  const [date, time] = value.split('T');
  if (!time) return value;
  const trimmed = time.replace('Z', '').split('.')[0];
  return `${date} ${trimmed}`;
}
