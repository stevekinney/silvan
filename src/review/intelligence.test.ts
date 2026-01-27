import { describe, expect, it } from 'bun:test';

import type { ReviewClassification } from '../agent/schemas';
import {
  applySeverityPolicy,
  buildReviewPriorityList,
  buildSeverityIndex,
  buildSeveritySummary,
} from './intelligence';

const fingerprints = [
  {
    threadId: 't1',
    comments: [{ id: 'c1', path: 'src/a.ts', line: 1, bodyDigest: 'a' }],
    isOutdated: false,
  },
  {
    threadId: 't2',
    comments: [{ id: 'c2', path: 'src/b.ts', line: 2, bodyDigest: 'b' }],
    isOutdated: false,
  },
  {
    threadId: 't3',
    comments: [{ id: 'c3', path: 'src/c.ts', line: 3, bodyDigest: 'c' }],
    isOutdated: false,
  },
];

describe('review intelligence', () => {
  it('derives severity from classification fallback', () => {
    const classification: ReviewClassification = {
      actionableThreadIds: ['t1'],
      ignoredThreadIds: ['t2'],
      needsContextThreadIds: ['t3'],
    };
    const index = buildSeverityIndex({ classification, fingerprints });
    expect(index.severityByThreadId['t1']).toBe('suggestion');
    expect(index.severityByThreadId['t2']).toBe('nitpick');
    expect(index.severityByThreadId['t3']).toBe('question');

    const summary = buildSeveritySummary(index.severityByThreadId);
    expect(summary.suggestion).toBe(1);
    expect(summary.nitpick).toBe(1);
    expect(summary.question).toBe(1);
  });

  it('applies severity policy', () => {
    const index = buildSeverityIndex({
      classification: {
        actionableThreadIds: [],
        ignoredThreadIds: [],
        needsContextThreadIds: [],
        threads: [
          { threadId: 't1', severity: 'blocking', summary: 'Stop' },
          { threadId: 't2', severity: 'nitpick', summary: 'Style' },
        ],
      },
      fingerprints,
    });
    const policy = {
      blocking: 'actionable',
      question: 'actionable',
      suggestion: 'actionable',
      nitpick: 'auto_resolve',
    } as const;
    const actions = applySeverityPolicy({
      severityByThreadId: index.severityByThreadId,
      policy,
    });
    expect(actions.actionableThreadIds).toContain('t1');
    expect(actions.autoResolveThreadIds).toContain('t2');
  });

  it('sorts priority by severity', () => {
    const index = buildSeverityIndex({
      classification: {
        actionableThreadIds: [],
        ignoredThreadIds: [],
        needsContextThreadIds: [],
        threads: [
          { threadId: 't2', severity: 'nitpick', summary: 'Style' },
          { threadId: 't1', severity: 'blocking', summary: 'Stop' },
        ],
      },
      fingerprints,
    });
    const priorities = buildReviewPriorityList({
      fingerprints,
      severityByThreadId: index.severityByThreadId,
      summaryByThreadId: index.summaryByThreadId,
    });
    expect(priorities[0]?.threadId).toBe('t1');
  });
});
