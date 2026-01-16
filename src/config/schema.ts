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
          enabled: z.array(z.enum(['linear', 'github', 'local'])).default(['local']),
          default: z.enum(['linear', 'github', 'local']).default('local'),
        })
        .default({ enabled: ['local'], default: 'local' }),
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
      providers: { enabled: ['local'], default: 'local' },
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
      cache: z
        .object({
          enabled: z.boolean().default(true),
        })
        .default({ enabled: true }),
      sessions: z
        .object({
          persist: z.boolean().default(false),
        })
        .default({ persist: false }),
      cognition: z
        .object({
          provider: z.enum(['anthropic', 'openai', 'gemini']).default('anthropic'),
          fallbackProviders: z
            .array(z.enum(['anthropic', 'openai', 'gemini']))
            .default([]),
          modelByTask: z
            .object({
              kickoffPrompt: z.string().optional(),
              plan: z.string().optional(),
              reviewKickoff: z.string().optional(),
              reviewClassify: z.string().optional(),
              reviewCluster: z.string().optional(),
              localReview: z.string().optional(),
              ciTriage: z.string().optional(),
              verificationSummary: z.string().optional(),
              recovery: z.string().optional(),
              prDraft: z.string().optional(),
              conversationSummary: z.string().optional(),
            })
            .default({}),
        })
        .default({
          provider: 'anthropic',
          fallbackProviders: [],
          modelByTask: {},
        }),
      conversation: z
        .object({
          pruning: z
            .object({
              maxTurns: z.number().int().positive().default(80),
              maxBytes: z.number().int().positive().default(200_000),
              summarizeAfterTurns: z.number().int().positive().default(30),
              keepLastTurns: z.number().int().positive().default(20),
            })
            .default({
              maxTurns: 80,
              maxBytes: 200_000,
              summarizeAfterTurns: 30,
              keepLastTurns: 20,
            }),
        })
        .default({
          pruning: {
            maxTurns: 80,
            maxBytes: 200_000,
            summarizeAfterTurns: 30,
            keepLastTurns: 20,
          },
        }),
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
      cache: { enabled: true },
      sessions: { persist: false },
      cognition: { provider: 'anthropic', fallbackProviders: [], modelByTask: {} },
      conversation: {
        pruning: {
          maxTurns: 80,
          maxBytes: 200_000,
          summarizeAfterTurns: 30,
          keepLastTurns: 20,
        },
      },
    }),
  review: z
    .object({
      maxIterations: z.number().int().positive().optional(),
      localGate: z
        .object({
          enabled: z.boolean().default(true),
          blockPrOnFail: z.boolean().default(true),
          runWhen: z
            .enum(['beforePrOpen', 'beforeReviewRequest', 'both'])
            .default('beforeReviewRequest'),
          requireVerifyBeforePr: z.boolean().default(true),
          thresholds: z
            .object({
              filesChangedWarn: z.number().int().positive().default(20),
              linesChangedWarn: z.number().int().positive().default(1500),
            })
            .default({ filesChangedWarn: 20, linesChangedWarn: 1500 }),
          severities: z
            .object({
              diffstat: z.enum(['blocker', 'warn', 'info']).default('warn'),
              diffstatLines: z.enum(['blocker', 'warn', 'info']).default('warn'),
              configFiles: z.enum(['blocker', 'warn', 'info']).default('warn'),
              dependencyFiles: z.enum(['blocker', 'warn', 'info']).default('warn'),
              lockfile: z.enum(['blocker', 'warn', 'info']).default('warn'),
              envFile: z.enum(['blocker', 'warn', 'info']).default('blocker'),
              consoleLog: z.enum(['blocker', 'warn', 'info']).default('warn'),
              debugger: z.enum(['blocker', 'warn', 'info']).default('blocker'),
              todo: z.enum(['blocker', 'warn', 'info']).default('warn'),
              diffCheck: z.enum(['blocker', 'warn', 'info']).default('blocker'),
              verifyFailed: z.enum(['blocker', 'warn', 'info']).default('blocker'),
              verifyMissing: z.enum(['blocker', 'warn', 'info']).default('blocker'),
              migration: z.enum(['blocker', 'warn', 'info']).default('warn'),
              branchNaming: z.enum(['blocker', 'warn', 'info']).default('warn'),
            })
            .partial()
            .default({}),
          allowConsoleLogPatterns: z.array(z.string()).default([]),
        })
        .default({
          enabled: true,
          blockPrOnFail: true,
          runWhen: 'beforeReviewRequest',
          requireVerifyBeforePr: true,
          thresholds: { filesChangedWarn: 20, linesChangedWarn: 1500 },
          severities: {},
          allowConsoleLogPatterns: [],
        }),
      aiReviewer: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({ enabled: false }),
    })
    .default({
      localGate: {
        enabled: true,
        blockPrOnFail: true,
        runWhen: 'beforeReviewRequest',
        requireVerifyBeforePr: true,
        thresholds: { filesChangedWarn: 20, linesChangedWarn: 1500 },
        severities: {},
        allowConsoleLogPatterns: [],
      },
      aiReviewer: { enabled: false },
    }),
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
