import { describe, expect, it } from 'bun:test';

import { formatDurationMs, parseTimeInput } from './time';

describe('time utils', () => {
  it('parses relative durations into ISO timestamps', () => {
    const nowMs = Date.parse('2025-01-08T00:00:00.000Z');
    expect(parseTimeInput('7d', nowMs)).toBe('2025-01-01T00:00:00.000Z');
    expect(parseTimeInput('24h', nowMs)).toBe('2025-01-07T00:00:00.000Z');
  });

  it('parses absolute timestamps', () => {
    expect(parseTimeInput('2025-01-01T12:30:00.000Z')).toBe('2025-01-01T12:30:00.000Z');
  });

  it('rejects invalid time values', () => {
    expect(parseTimeInput('not-a-date')).toBeNull();
    expect(parseTimeInput('12x')).toBeNull();
  });

  it('formats durations with compact units', () => {
    expect(formatDurationMs(900)).toBe('900ms');
    expect(formatDurationMs(90_000)).toBe('1m 30s');
    expect(formatDurationMs(3_600_000)).toBe('1h');
  });
});
