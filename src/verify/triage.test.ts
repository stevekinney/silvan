import { describe, expect, it } from 'bun:test';

import { triageVerificationFailures } from './triage';

describe('triageVerificationFailures', () => {
  it('classifies known verification failures', () => {
    const result = triageVerificationFailures([
      { name: 'lint', exitCode: 1, stderr: 'error' },
      { name: 'test', exitCode: 2, stderr: 'fail' },
    ]);
    expect(result.classified).toBe(true);
    expect(result.decision.commands).toEqual(['lint', 'test']);
    expect(result.decision.askUser).toBeUndefined();
  });

  it('asks for guidance when failures are unclassified', () => {
    const result = triageVerificationFailures([
      { name: 'deploy-step', exitCode: 1, stderr: 'error' },
    ]);
    expect(result.classified).toBe(false);
    expect(result.decision.askUser).toBe(true);
  });
});
