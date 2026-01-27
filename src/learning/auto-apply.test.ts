import { describe, expect, it } from 'bun:test';

import {
  buildLearningConsistency,
  evaluateLearningTargets,
  scoreLearningConfidence,
} from './auto-apply';

const baseNotes = {
  summary: 'Summary',
  rules: ['Document CI recovery steps'],
  skills: [],
  docs: ['Add a troubleshooting section'],
};

describe('learning auto-apply scoring', () => {
  it('scores higher when notes match prior runs', () => {
    const history = [
      {
        runId: 'run-1',
        notes: {
          summary: 'Earlier summary',
          rules: ['Document CI recovery steps'],
          skills: [],
          docs: ['Add a troubleshooting section'],
        },
      },
    ];
    const consistency = buildLearningConsistency(baseNotes, history, 1);
    expect(consistency.score).toBe(1);
  });

  it('produces a high confidence when ci/review are healthy', () => {
    const result = scoreLearningConfidence({
      notes: baseNotes,
      history: [
        {
          runId: 'run-1',
          notes: baseNotes,
        },
      ],
      minSamples: 1,
      threshold: 0.7,
      ci: 'passing',
      unresolvedReviews: 0,
      aiReviewShipIt: true,
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe('learning target validation', () => {
  it('flags unsafe extensions', () => {
    const result = evaluateLearningTargets({
      targets: { rules: 'src/index.ts' },
      worktreeRoot: '/repo',
    });
    expect(result.ok).toBe(false);
  });
});
