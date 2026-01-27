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
      review: z
        .object({
          requireApproval: z.boolean().default(false),
          requiredApprovals: z.number().int().positive().default(1),
          pollIntervalMs: z.number().int().positive().default(15000),
          timeoutMs: z.number().int().positive().default(900000),
        })
        .default({
          requireApproval: false,
          requiredApprovals: 1,
          pollIntervalMs: 15000,
          timeoutMs: 900000,
        }),
    })
    .default({
      reviewers: [],
      requestCopilot: true,
      review: {
        requireApproval: false,
        requiredApprovals: 1,
        pollIntervalMs: 15000,
        timeoutMs: 900000,
      },
    }),
  verify: z
    .object({
      commands: z.array(verificationCommandSchema).default([]),
      failFast: z.boolean().default(true),
      shell: z.string().optional(),
      autoFix: z
        .object({
          enabled: z.boolean().default(true),
          maxAttempts: z.number().int().positive().default(2),
        })
        .default({ enabled: true, maxAttempts: 2 }),
    })
    .default({
      commands: [],
      failFast: true,
      autoFix: { enabled: true, maxAttempts: 2 },
    }),
  naming: z
    .object({
      branchPrefix: z.string().default('feature/'),
      worktreeDir: z.string().default('.worktrees'),
    })
    .default({ branchPrefix: 'feature/', worktreeDir: '.worktrees' }),
  features: z
    .object({
      autoMode: z.boolean().default(false),
      cognitionDefaults: z.boolean().default(false),
    })
    .default({ autoMode: false, cognitionDefaults: false }),
  state: z
    .object({
      mode: z.enum(['global', 'repo']).default('global'),
      root: z.string().optional(),
    })
    .default({ mode: 'global' }),
  queue: z
    .object({
      priority: z
        .object({
          default: z.number().int().min(1).max(10).default(5),
          escalation: z
            .object({
              afterMinutes: z.number().int().positive().default(30),
              stepMinutes: z.number().int().positive().default(30),
              boost: z.number().int().positive().default(1),
              max: z.number().int().min(1).max(10).default(10),
            })
            .default({ afterMinutes: 30, stepMinutes: 30, boost: 1, max: 10 }),
          tiers: z
            .object({
              highMin: z.number().int().min(1).max(10).default(8),
              mediumMin: z.number().int().min(1).max(10).default(4),
            })
            .default({ highMin: 8, mediumMin: 4 }),
        })
        .default({
          default: 5,
          escalation: { afterMinutes: 30, stepMinutes: 30, boost: 1, max: 10 },
          tiers: { highMin: 8, mediumMin: 4 },
        }),
      concurrency: z
        .object({
          default: z.number().int().positive().default(2),
          tiers: z
            .object({
              high: z.number().int().positive().default(2),
              medium: z.number().int().positive().default(1),
              low: z.number().int().positive().default(1),
            })
            .default({ high: 2, medium: 1, low: 1 }),
        })
        .default({ default: 2, tiers: { high: 2, medium: 1, low: 1 } }),
    })
    .default({
      priority: {
        default: 5,
        escalation: { afterMinutes: 30, stepMinutes: 30, boost: 1, max: 10 },
        tiers: { highMin: 8, mediumMin: 4 },
      },
      concurrency: { default: 2, tiers: { high: 2, medium: 1, low: 1 } },
    })
    .superRefine((value, ctx) => {
      if (value.priority.tiers.highMin <= value.priority.tiers.mediumMin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'queue.priority.tiers.highMin must be greater than mediumMin',
          path: ['priority', 'tiers', 'highMin'],
        });
      }
    }),
  ui: z
    .object({
      worktrees: z
        .object({
          staleAfterDays: z.number().int().positive().default(7),
        })
        .default({ staleAfterDays: 7 }),
    })
    .default({ worktrees: { staleAfterDays: 7 } }),
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
          routing: z
            .object({
              enabled: z.boolean().default(true),
              autoApply: z.boolean().default(true),
              minSamples: z.number().int().positive().default(10),
              maxLatencyDelta: z.number().positive().default(0.2),
              lookbackDays: z.number().int().positive().default(30),
              respectOverrides: z.boolean().default(true),
            })
            .default({
              enabled: true,
              autoApply: true,
              minSamples: 10,
              maxLatencyDelta: 0.2,
              lookbackDays: 30,
              respectOverrides: true,
            }),
          modelByTask: z
            .object({
              kickoffPrompt: z.string().optional(),
              initDefaults: z.string().optional(),
              plan: z.string().optional(),
              reviewKickoff: z.string().optional(),
              reviewClassify: z.string().optional(),
              reviewCluster: z.string().optional(),
              localReview: z.string().optional(),
              ciTriage: z.string().optional(),
              verificationSummary: z.string().optional(),
              verificationFix: z.string().optional(),
              recovery: z.string().optional(),
              prDraft: z.string().optional(),
              learningNotes: z.string().optional(),
              conversationSummary: z.string().optional(),
            })
            .default({}),
        })
        .default({
          provider: 'anthropic',
          fallbackProviders: [],
          routing: {
            enabled: true,
            autoApply: true,
            minSamples: 10,
            maxLatencyDelta: 0.2,
            lookbackDays: 30,
            respectOverrides: true,
          },
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
          optimization: z
            .object({
              enabled: z.boolean().default(true),
              retention: z
                .object({
                  system: z.number().int().positive().default(6),
                  user: z.number().int().positive().default(12),
                  assistant: z.number().int().positive().default(8),
                  tool: z.number().int().positive().default(12),
                  error: z.number().int().positive().default(6),
                  correction: z.number().int().positive().default(6),
                })
                .default({
                  system: 6,
                  user: 12,
                  assistant: 8,
                  tool: 12,
                  error: 6,
                  correction: 6,
                }),
              correctionPatterns: z
                .array(z.string())
                .default(['\\bactually\\b', '\\bcorrection\\b', '\\bupdate\\b']),
            })
            .default({
              enabled: true,
              retention: {
                system: 6,
                user: 12,
                assistant: 8,
                tool: 12,
                error: 6,
                correction: 6,
              },
              correctionPatterns: ['\\bactually\\b', '\\bcorrection\\b', '\\bupdate\\b'],
            }),
        })
        .default({
          pruning: {
            maxTurns: 80,
            maxBytes: 200_000,
            summarizeAfterTurns: 30,
            keepLastTurns: 20,
          },
          optimization: {
            enabled: true,
            retention: {
              system: 6,
              user: 12,
              assistant: 8,
              tool: 12,
              error: 6,
              correction: 6,
            },
            correctionPatterns: ['\\bactually\\b', '\\bcorrection\\b', '\\bupdate\\b'],
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
      cognition: {
        provider: 'anthropic',
        fallbackProviders: [],
        routing: {
          enabled: true,
          autoApply: true,
          minSamples: 10,
          maxLatencyDelta: 0.2,
          lookbackDays: 30,
          respectOverrides: true,
        },
        modelByTask: {},
      },
      conversation: {
        pruning: {
          maxTurns: 80,
          maxBytes: 200_000,
          summarizeAfterTurns: 30,
          keepLastTurns: 20,
        },
        optimization: {
          enabled: true,
          retention: {
            system: 6,
            user: 12,
            assistant: 8,
            tool: 12,
            error: 6,
            correction: 6,
          },
          correctionPatterns: ['\\bactually\\b', '\\bcorrection\\b', '\\bupdate\\b'],
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
          enabled: z.boolean().default(true),
        })
        .default({ enabled: true }),
      intelligence: z
        .object({
          enabled: z.boolean().default(true),
          severityPolicy: z
            .object({
              blocking: z
                .enum(['actionable', 'ignore', 'auto_resolve'])
                .default('actionable'),
              question: z
                .enum(['actionable', 'ignore', 'auto_resolve'])
                .default('actionable'),
              suggestion: z
                .enum(['actionable', 'ignore', 'auto_resolve'])
                .default('actionable'),
              nitpick: z
                .enum(['actionable', 'ignore', 'auto_resolve'])
                .default('actionable'),
            })
            .default({
              blocking: 'actionable',
              question: 'actionable',
              suggestion: 'actionable',
              nitpick: 'actionable',
            }),
          nitpickAcknowledgement: z
            .string()
            .default('Noted - resolving as a nitpick for now.'),
          reviewerSuggestions: z
            .object({
              enabled: z.boolean().default(true),
              useCodeowners: z.boolean().default(true),
              useBlame: z.boolean().default(true),
              maxSuggestions: z.number().int().min(1).default(5),
              autoRequest: z.boolean().default(false),
              reviewerAliases: z.record(z.string(), z.string()).default({}),
            })
            .default({
              enabled: true,
              useCodeowners: true,
              useBlame: true,
              maxSuggestions: 5,
              autoRequest: false,
              reviewerAliases: {},
            }),
        })
        .default({
          enabled: true,
          severityPolicy: {
            blocking: 'actionable',
            question: 'actionable',
            suggestion: 'actionable',
            nitpick: 'actionable',
          },
          nitpickAcknowledgement: 'Noted - resolving as a nitpick for now.',
          reviewerSuggestions: {
            enabled: true,
            useCodeowners: true,
            useBlame: true,
            maxSuggestions: 5,
            autoRequest: false,
            reviewerAliases: {},
          },
        }),
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
      aiReviewer: { enabled: true },
      intelligence: {
        enabled: true,
        severityPolicy: {
          blocking: 'actionable',
          question: 'actionable',
          suggestion: 'actionable',
          nitpick: 'actionable',
        },
        nitpickAcknowledgement: 'Noted - resolving as a nitpick for now.',
        reviewerSuggestions: {
          enabled: true,
          useCodeowners: true,
          useBlame: true,
          maxSuggestions: 5,
          autoRequest: false,
          reviewerAliases: {},
        },
      },
    }),
  learning: z
    .object({
      enabled: z.boolean().default(true),
      mode: z.enum(['artifact', 'apply']).default('artifact'),
      ai: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({ enabled: false }),
      autoApply: z
        .object({
          enabled: z.boolean().default(true),
          threshold: z.number().min(0).max(1).default(0.7),
          minSamples: z.number().int().min(0).default(3),
          lookbackDays: z.number().int().min(1).default(30),
          maxHistory: z.number().int().min(1).default(50),
        })
        .default({
          enabled: true,
          threshold: 0.7,
          minSamples: 3,
          lookbackDays: 30,
          maxHistory: 50,
        }),
      targets: z
        .object({
          rules: z.string().default('docs/rules.md'),
          skills: z.string().default('docs/skills.md'),
          docs: z.string().default('docs/learned.md'),
        })
        .partial()
        .default({
          rules: 'docs/rules.md',
          skills: 'docs/skills.md',
          docs: 'docs/learned.md',
        }),
    })
    .default({
      enabled: true,
      mode: 'artifact',
      ai: { enabled: false },
      autoApply: {
        enabled: true,
        threshold: 0.7,
        minSamples: 3,
        lookbackDays: 30,
        maxHistory: 50,
      },
      targets: {
        rules: 'docs/rules.md',
        skills: 'docs/skills.md',
        docs: 'docs/learned.md',
      },
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
