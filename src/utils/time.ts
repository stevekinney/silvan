export type RelativeUnit = 's' | 'm' | 'h' | 'd' | 'w';

const UNIT_TO_SECONDS: Record<RelativeUnit, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 60 * 60 * 24,
  w: 60 * 60 * 24 * 7,
};

export function parseTimeInput(value: string, nowMs = Date.now()): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const relativeMatch = trimmed.match(/^(\d+)([smhdw])$/i);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2]?.toLowerCase() as RelativeUnit;
    if (!Number.isFinite(amount) || amount < 0 || !UNIT_TO_SECONDS[unit]) {
      return null;
    }
    const deltaMs = amount * UNIT_TO_SECONDS[unit] * 1000;
    return new Date(nowMs - deltaMs).toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }

  return null;
}

export function formatDurationMs(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 'unknown';
  }

  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }

  let remaining = Math.round(value / 1000);
  const units: Array<[RelativeUnit, number]> = [
    ['d', UNIT_TO_SECONDS.d],
    ['h', UNIT_TO_SECONDS.h],
    ['m', UNIT_TO_SECONDS.m],
    ['s', UNIT_TO_SECONDS.s],
  ];

  const parts: string[] = [];
  for (const [label, seconds] of units) {
    const amount = Math.floor(remaining / seconds);
    if (amount <= 0) continue;
    parts.push(`${amount}${label}`);
    remaining -= amount * seconds;
    if (parts.length >= 2) break;
  }

  return parts.length > 0 ? parts.join(' ') : '0s';
}
