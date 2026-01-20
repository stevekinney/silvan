import { describe, expect, test } from 'bun:test';

import type { ExecutionKickoffBody } from '../../prompts/schema';
import { normalizeExecutionKickoffBody } from './kickoff';

describe('normalizeExecutionKickoffBody', () => {
  test('fills missing suggestedApproach and ignores unknown keys', () => {
    const fallback: ExecutionKickoffBody = {
      objective: 'Fallback objective',
      context: {
        task: {
          key: 'TASK-1',
          title: 'Fallback task',
          summary: 'Fallback summary',
          acceptanceCriteria: ['Fallback criteria'],
        },
        repo: {
          type: 'repo',
          frameworks: [],
          keyPackages: [],
          entrypoints: [],
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
      suggestedApproach: ['Fallback step'],
    };

    const candidate = {
      objective: 'Model objective',
      context: {
        task: {
          key: 'TASK-2',
          title: 'Model task',
          summary: 'Model summary',
          acceptanceCriteria: ['Model criteria'],
        },
        repo: {
          type: 'app',
          frameworks: ['svelte'],
          keyPackages: ['pkg'],
          entrypoints: ['src'],
        },
      },
      constraints: {
        mustDo: ['Do X'],
        mustNotDo: ['Do Y'],
        assumptions: ['Assume Z'],
      },
      executionRules: {
        readBeforeWrite: false,
        noSpeculativeChanges: false,
        toolDrivenOnly: false,
        smallCommitsPreferred: false,
      },
      successDefinition: {
        functional: ['Functional'],
        verification: ['Verify'],
        nonGoals: ['None'],
      },
      ['suggestedApproach": ["bad"]}</invoke>']: ['bad'],
    } as Record<string, unknown>;

    const result = normalizeExecutionKickoffBody(candidate, fallback);

    expect(result.objective).toBe('Model objective');
    expect(result.context.task.key).toBe('TASK-2');
    expect(result.executionRules.readBeforeWrite).toBe(false);
    expect(result.suggestedApproach).toEqual(fallback.suggestedApproach);
  });
});
