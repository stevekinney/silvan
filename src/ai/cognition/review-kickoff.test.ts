import { describe, expect, test } from 'bun:test';

import type { ReviewRemediationBody } from '../../prompts/schema';
import { normalizeReviewRemediationBody } from './review-kickoff';

describe('normalizeReviewRemediationBody', () => {
  test('uses fallback for missing suggestedApproach', () => {
    const fallback: ReviewRemediationBody = {
      objective: 'Fallback objective',
      context: {
        task: {
          key: 'TASK-1',
          title: 'Fallback task',
          acceptanceCriteria: ['Criterion'],
        },
        pr: {
          id: 'PR-1',
          branch: 'main',
        },
        review: {
          unresolvedThreadCount: 1,
          threadFingerprints: [
            {
              threadId: 'thread-1',
              commentIds: ['comment-1'],
              path: 'src/index.ts',
              line: 10,
              isOutdated: false,
              bodyHash: 'hash',
            },
          ],
        },
        ci: {
          state: 'unknown',
          failedChecks: [],
        },
        repo: {
          frameworks: [],
          verificationCommands: [],
        },
      },
      constraints: {
        mustDo: ['Do A'],
        mustNotDo: ['Do B'],
        assumptions: ['Assume C'],
      },
      executionRules: {
        toolDrivenOnly: true,
        readBeforeWrite: true,
        noSpeculativeChanges: true,
        preferSmallScopedFixes: true,
        avoidUnrelatedRefactors: true,
        batchRelatedComments: true,
        resolveThreadsOnlyAfterProof: true,
      },
      loopPolicy: {
        prioritizeCiFailuresFirst: true,
        maxIterations: 2,
        stopWhen: {
          ciPassing: true,
          noUnresolvedThreads: true,
        },
      },
      successDefinition: {
        functional: ['Done'],
        verification: ['Verify'],
        review: ['Resolve'],
      },
      suggestedApproach: ['Fallback step'],
      threadStrategy: {
        clusterThemes: [],
        needsFullThreadFetch: ['thread-1'],
        ignoreAsOutdated: [],
      },
    };

    const candidate = {
      objective: 'Model objective',
      constraints: {
        mustDo: ['Do X'],
        mustNotDo: ['Do Y'],
        assumptions: ['Assume Z'],
      },
      executionRules: {
        toolDrivenOnly: false,
        readBeforeWrite: false,
        noSpeculativeChanges: false,
        preferSmallScopedFixes: false,
        avoidUnrelatedRefactors: false,
        batchRelatedComments: false,
        resolveThreadsOnlyAfterProof: false,
      },
      loopPolicy: {
        prioritizeCiFailuresFirst: false,
        maxIterations: 3,
        stopWhen: {
          ciPassing: false,
          noUnresolvedThreads: false,
        },
      },
      successDefinition: {
        functional: ['Functional'],
        verification: ['Checks'],
        review: ['Review'],
      },
      ['suggestedApproach": ["bad"]}</invoke>']: ['bad'],
    } as Record<string, unknown>;

    const result = normalizeReviewRemediationBody(candidate, fallback);

    expect(result.objective).toBe('Model objective');
    expect(result.constraints.mustDo).toEqual(['Do X']);
    expect(result.suggestedApproach).toEqual(fallback.suggestedApproach);
  });
});
