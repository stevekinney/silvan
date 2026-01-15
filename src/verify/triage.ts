import type { VerificationDecision } from '../agent/verifier';

type VerificationResult = {
  name: string;
  exitCode: number;
  stderr: string;
};

export type VerificationTriage = {
  decision: VerificationDecision;
  classified: boolean;
};

const knownTags = ['lint', 'test', 'type', 'check', 'build'];

export function triageVerificationFailures(
  results: VerificationResult[],
): VerificationTriage {
  const failed = results.filter((result) => result.exitCode !== 0);
  const classified = failed.every((result) =>
    knownTags.some((tag) => result.name.toLowerCase().includes(tag)),
  );
  const decision: VerificationDecision = {
    commands: failed.map((result) => result.name),
    rationale: 'Rerun the failed verification commands to diagnose issues.',
    ...(classified ? {} : { askUser: true }),
  };

  return { decision, classified };
}
