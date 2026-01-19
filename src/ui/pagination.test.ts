import { describe, expect, it } from 'bun:test';

import { calculatePageSize } from './pagination';

describe('calculatePageSize', () => {
  it('calculates page size from terminal height', () => {
    expect(calculatePageSize(40)).toBe(33);
    expect(calculatePageSize(24)).toBe(17);
  });

  it('respects minimum rows', () => {
    expect(calculatePageSize(6)).toBe(5);
  });
});
