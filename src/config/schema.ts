import { z } from 'zod';

export const verificationCommandSchema = z.object({
  name: z.string().min(1),
  cmd: z.string().min(1),
  args: z.array(z.string()).optional(),
});

export const configSchema = z.object({
  task: z
    .object({
      providers: z
        .object({
          enabled: z.array(z.enum(['linear', 'github'])).default(['linear']),
          default: z.enum(['linear', 'github']).default('linear'),
        })
        .default({ enabled: ['linear'], default: 'linear' }),
      github: z
        .object({
          closeOnSuccess: z.boolean().default(false),
          commentOnPrOpen: z.boolean().default(false),
          labelMapping: z.record(z.string(), z.string()).optional(),
        })
        .default({ closeOnSuccess: false, commentOnPrOpen: false }),
      linear: z
        .object({
          states: z
            .object({
              inProgress: z.string().default('In Progress'),
              inReview: z.string().optional(),
              done: z.string().optional(),
            })
            .default({ inProgress: 'In Progress' }),
        })
        .default({ states: { inProgress: 'In Progress' } }),
    })
    .default({
      providers: { enabled: ['linear'], default: 'linear' },
      github: { closeOnSuccess: false, commentOnPrOpen: false },
      linear: { states: { inProgress: 'In Progress' } },
    }),
  repo: z
    .object({
      defaultBranch: z.string().default('main'),
    })
    .default({ defaultBranch: 'main' }),
  linear: z
    .object({
      token: z.string().optional(),
    })
    .default({}),
  github: z
    .object({
      owner: z.string().optional(),
      repo: z.string().optional(),
      token: z.string().optional(),
      reviewers: z.array(z.string()).default([]),
      requestCopilot: z.boolean().default(true),
      baseBranch: z.string().optional(),
    })
    .default({ reviewers: [], requestCopilot: true }),
  verify: z
    .object({
      commands: z.array(verificationCommandSchema).default([]),
      failFast: z.boolean().default(true),
      shell: z.string().optional(),
    })
    .default({ commands: [], failFast: true }),
  naming: z
    .object({
      branchPrefix: z.string().default('feature/'),
      worktreeDir: z.string().default('.worktrees'),
    })
    .default({ branchPrefix: 'feature/', worktreeDir: '.worktrees' }),
  features: z
    .object({
      autoMode: z.boolean().default(false),
    })
    .default({ autoMode: false }),
  state: z
    .object({
      mode: z.enum(['global', 'repo']).default('global'),
      root: z.string().optional(),
    })
    .default({ mode: 'global' }),
  ai: z
    .object({
      models: z
        .object({
          default: z.string().optional(),
          plan: z.string().optional(),
          execute: z.string().optional(),
          review: z.string().optional(),
          verify: z.string().optional(),
          pr: z.string().optional(),
          recovery: z.string().optional(),
        })
        .default({}),
      budgets: z
        .object({
          default: z
            .object({
              maxTurns: z.number().int().positive().optional(),
              maxBudgetUsd: z.number().positive().optional(),
              maxThinkingTokens: z.number().int().positive().optional(),
            })
            .default({}),
          plan: z
            .object({
              maxTurns: z.number().int().positive().optional(),
              maxBudgetUsd: z.number().positive().optional(),
              maxThinkingTokens: z.number().int().positive().optional(),
            })
            .default({}),
          execute: z
            .object({
              maxTurns: z.number().int().positive().optional(),
              maxBudgetUsd: z.number().positive().optional(),
              maxThinkingTokens: z.number().int().positive().optional(),
            })
            .default({}),
          review: z
            .object({
              maxTurns: z.number().int().positive().optional(),
              maxBudgetUsd: z.number().positive().optional(),
              maxThinkingTokens: z.number().int().positive().optional(),
            })
            .default({}),
          verify: z
            .object({
              maxTurns: z.number().int().positive().optional(),
              maxBudgetUsd: z.number().positive().optional(),
              maxThinkingTokens: z.number().int().positive().optional(),
            })
            .default({}),
          pr: z
            .object({
              maxTurns: z.number().int().positive().optional(),
              maxBudgetUsd: z.number().positive().optional(),
              maxThinkingTokens: z.number().int().positive().optional(),
            })
            .default({}),
          recovery: z
            .object({
              maxTurns: z.number().int().positive().optional(),
              maxBudgetUsd: z.number().positive().optional(),
              maxThinkingTokens: z.number().int().positive().optional(),
            })
            .default({}),
        })
        .default({
          default: {},
          plan: {},
          execute: {},
          review: {},
          verify: {},
          pr: {},
          recovery: {},
        }),
      toolLimits: z
        .object({
          maxCalls: z.number().int().positive().optional(),
          maxDurationMs: z.number().int().positive().optional(),
        })
        .default({}),
      sessions: z
        .object({
          persist: z.boolean().default(false),
        })
        .default({ persist: false }),
    })
    .default({
      models: {},
      budgets: {
        default: {},
        plan: {},
        execute: {},
        review: {},
        verify: {},
        pr: {},
        recovery: {},
      },
      toolLimits: {},
      sessions: { persist: false },
    }),
  review: z
    .object({
      maxIterations: z.number().int().positive().optional(),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends Record<string, unknown>
      ? DeepPartial<T[K]>
      : T[K];
};
export type ConfigInput = DeepPartial<Config>;
