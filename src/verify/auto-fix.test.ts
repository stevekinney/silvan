import { describe, expect, it } from 'bun:test';

import { shouldAttemptVerificationAutoFix } from './auto-fix';

describe('verification auto-fix', () => {
  it('blocks auto-fix when disabled', () => {
    const result = shouldAttemptVerificationAutoFix({
      enabled: false,
      maxAttempts: 2,
      attempts: 0,
      classified: true,
      apply: true,
      dryRun: false,
    });
    expect(result.attempt).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('blocks auto-fix when attempts are exhausted', () => {
    const result = shouldAttemptVerificationAutoFix({
      enabled: true,
      maxAttempts: 2,
      attempts: 2,
      classified: true,
      apply: true,
      dryRun: false,
    });
    expect(result.attempt).toBe(false);
    expect(result.reason).toBe('max_attempts');
  });

  it('allows auto-fix when classified and enabled', () => {
    const result = shouldAttemptVerificationAutoFix({
      enabled: true,
      maxAttempts: 2,
      attempts: 0,
      classified: true,
      apply: true,
      dryRun: false,
    });
    expect(result.attempt).toBe(true);
  });
});
