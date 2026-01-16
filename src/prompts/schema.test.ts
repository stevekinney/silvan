import { describe, expect, it } from 'bun:test';

import { hashInputs, hashPrompt, validatePrompt } from './index';

describe('prompt schema', () => {
  it('validates execution kickoff prompt', () => {
    const payload = {
      promptVersion: '1.0',
      promptKind: 'execution_kickoff',
      createdAt: new Date().toISOString(),
      source: 'silvan',
      id: 'prompt-1',
      inputsDigest: 'inputs',
      body: {
        objective: 'Implement feature X',
        context: {
          task: {
            key: 'LOCAL-1',
            title: 'Feature X',
            summary: 'Add feature X',
            acceptanceCriteria: ['A', 'B'],
          },
          repo: {
            type: 'app',
            frameworks: ['svelte'],
            keyPackages: ['pkg'],
            entrypoints: ['src'],
          },
        },
        constraints: {
          mustDo: ['Do A'],
          mustNotDo: ['Do B'],
          assumptions: ['Assume C'],
        },
        executionRules: {
          readBeforeWrite: true,
          noSpeculativeChanges: true,
          toolDrivenOnly: true,
          smallCommitsPreferred: true,
        },
        successDefinition: {
          functional: ['Works'],
          verification: ['Tests pass'],
          nonGoals: ['No refactor'],
        },
        suggestedApproach: ['Step 1'],
      },
    };

    const prompt = validatePrompt('execution_kickoff', payload);
    expect(prompt.promptKind).toBe('execution_kickoff');
  });

  it('rejects extra keys', () => {
    const payload = {
      promptVersion: '1.0',
      promptKind: 'execution_kickoff',
      createdAt: new Date().toISOString(),
      source: 'silvan',
      id: 'prompt-1',
      inputsDigest: 'inputs',
      body: {
        objective: 'Implement feature X',
        context: {
          task: {
            key: 'LOCAL-1',
            title: 'Feature X',
            summary: 'Add feature X',
            acceptanceCriteria: ['A', 'B'],
          },
          repo: {
            type: 'app',
            frameworks: ['svelte'],
            keyPackages: ['pkg'],
            entrypoints: ['src'],
          },
        },
        constraints: {
          mustDo: ['Do A'],
          mustNotDo: ['Do B'],
          assumptions: ['Assume C'],
        },
        executionRules: {
          readBeforeWrite: true,
          noSpeculativeChanges: true,
          toolDrivenOnly: true,
          smallCommitsPreferred: true,
        },
        successDefinition: {
          functional: ['Works'],
          verification: ['Tests pass'],
          nonGoals: ['No refactor'],
        },
        suggestedApproach: ['Step 1'],
        extra: 'nope',
      },
    };

    expect(() => validatePrompt('execution_kickoff', payload)).toThrow();
  });

  it('hashes inputs and prompts deterministically', () => {
    const inputsA = { task: { id: '1', title: 'A' } };
    const inputsB = { task: { id: '1', title: 'B' } };
    const digestA = hashInputs(inputsA);
    const digestB = hashInputs(inputsB);
    expect(digestA).not.toBe(digestB);

    const prompt = validatePrompt('execution_kickoff', {
      promptVersion: '1.0',
      promptKind: 'execution_kickoff',
      createdAt: new Date().toISOString(),
      source: 'silvan',
      id: 'prompt-1',
      inputsDigest: digestA,
      body: {
        objective: 'Implement feature X',
        context: {
          task: {
            key: 'LOCAL-1',
            title: 'Feature X',
            summary: 'Add feature X',
            acceptanceCriteria: ['A', 'B'],
          },
          repo: {
            type: 'app',
            frameworks: ['svelte'],
            keyPackages: ['pkg'],
            entrypoints: ['src'],
          },
        },
        constraints: {
          mustDo: ['Do A'],
          mustNotDo: ['Do B'],
          assumptions: ['Assume C'],
        },
        executionRules: {
          readBeforeWrite: true,
          noSpeculativeChanges: true,
          toolDrivenOnly: true,
          smallCommitsPreferred: true,
        },
        successDefinition: {
          functional: ['Works'],
          verification: ['Tests pass'],
          nonGoals: ['No refactor'],
        },
        suggestedApproach: ['Step 1'],
      },
    });
    const hashA = hashPrompt(prompt);
    const hashB = hashPrompt(prompt);
    expect(hashA).toBe(hashB);
  });

  it('validates review remediation prompt', () => {
    const payload = {
      promptVersion: '1.0',
      promptKind: 'review_remediation_kickoff',
      createdAt: new Date().toISOString(),
      source: 'silvan',
      id: 'prompt-2',
      inputsDigest: 'inputs',
      body: {
        objective: 'Fix review comments',
        context: {
          task: {
            key: 'LOCAL-2',
            title: 'Fixes',
            acceptanceCriteria: ['A'],
          },
          pr: {
            id: 'org/repo#1',
            url: 'https://example.com',
            branch: 'feature/test',
          },
          review: {
            unresolvedThreadCount: 1,
            threadFingerprints: [
              {
                threadId: 't1',
                commentIds: ['c1'],
                path: 'src/index.ts',
                line: 10,
                isOutdated: false,
                bodyHash: 'hash',
                excerpt: 'excerpt',
              },
            ],
          },
          ci: {
            state: 'passing',
            summary: 'ok',
            failedChecks: [],
          },
          repo: {
            frameworks: [],
            verificationCommands: ['bun test'],
          },
        },
        constraints: {
          mustDo: ['Fix issues'],
          mustNotDo: ['No refactor'],
          assumptions: ['Repo ok'],
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
          maxIterations: 3,
          stopWhen: { ciPassing: true, noUnresolvedThreads: true },
        },
        successDefinition: {
          functional: ['Fix comments'],
          verification: ['CI passes'],
          review: ['No unresolved'],
        },
        suggestedApproach: ['Cluster threads'],
        threadStrategy: {
          clusterThemes: [
            {
              theme: 'theme',
              threadIds: ['t1'],
              rationale: 'similar',
            },
          ],
          needsFullThreadFetch: [],
          ignoreAsOutdated: [],
        },
      },
    };

    const prompt = validatePrompt('review_remediation_kickoff', payload);
    expect(prompt.promptKind).toBe('review_remediation_kickoff');
  });
});
