export type AutoFixDecision = {
  attempt: boolean;
  reason?: string;
};

export function shouldAttemptVerificationAutoFix(options: {
  enabled: boolean;
  maxAttempts: number;
  attempts: number;
  classified: boolean;
  apply: boolean;
  dryRun: boolean;
}): AutoFixDecision {
  if (!options.enabled) {
    return { attempt: false, reason: 'disabled' };
  }
  if (options.dryRun) {
    return { attempt: false, reason: 'dry_run' };
  }
  if (!options.apply) {
    return { attempt: false, reason: 'apply_disabled' };
  }
  if (options.attempts >= options.maxAttempts) {
    return { attempt: false, reason: 'max_attempts' };
  }
  if (!options.classified) {
    return { attempt: false, reason: 'unclassified' };
  }
  return { attempt: true };
}
