import { z } from 'zod';

export const promptKinds = [
  'execution_kickoff',
  'review_remediation_kickoff',
  'pr_draft_kickoff',
  'recovery_kickoff',
  'verification_decision',
] as const;

export const promptEnvelopeSchema = z
  .object({
    promptVersion: z.string().min(1),
    promptKind: z.enum(promptKinds),
    createdAt: z.string().min(1),
    source: z.literal('silvan'),
    id: z.string().min(1),
    inputsDigest: z.string().min(1),
    model: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
      })
      .optional(),
  })
  .strict();

const executionKickoffBodySchema = z
  .object({
    objective: z.string().min(1),
    context: z.object({
      task: z.object({
        key: z.string().min(1),
        title: z.string().min(1),
        summary: z.string().min(1),
        acceptanceCriteria: z.array(z.string()),
      }),
      repo: z.object({
        type: z.string().min(1),
        frameworks: z.array(z.string()),
        keyPackages: z.array(z.string()),
        entrypoints: z.array(z.string()),
      }),
    }),
    constraints: z.object({
      mustDo: z.array(z.string()),
      mustNotDo: z.array(z.string()),
      assumptions: z.array(z.string()),
    }),
    executionRules: z.object({
      readBeforeWrite: z.boolean(),
      noSpeculativeChanges: z.boolean(),
      toolDrivenOnly: z.boolean(),
      smallCommitsPreferred: z.boolean(),
    }),
    successDefinition: z.object({
      functional: z.array(z.string()),
      verification: z.array(z.string()),
      nonGoals: z.array(z.string()),
    }),
    suggestedApproach: z.array(z.string()),
  })
  .strict();

const reviewRemediationBodySchema = z
  .object({
    objective: z.string().min(1),
    context: z.object({
      task: z.object({
        key: z.string().min(1),
        title: z.string().min(1),
        acceptanceCriteria: z.array(z.string()),
      }),
      pr: z.object({
        id: z.string().min(1),
        url: z.string().optional(),
        branch: z.string().min(1),
      }),
      review: z.object({
        unresolvedThreadCount: z.number().int().nonnegative(),
        threadFingerprints: z.array(
          z.object({
            threadId: z.string().min(1),
            commentIds: z.array(z.string()),
            path: z.string().nullable(),
            line: z.number().int().nonnegative().optional(),
            isOutdated: z.boolean(),
            bodyHash: z.string().min(1),
            excerpt: z.string().optional(),
          }),
        ),
      }),
      ci: z.object({
        state: z.enum(['unknown', 'pending', 'passing', 'failing']),
        summary: z.string().optional(),
        failedChecks: z.array(z.string()),
      }),
      repo: z.object({
        frameworks: z.array(z.string()),
        verificationCommands: z.array(z.string()),
      }),
    }),
    constraints: z.object({
      mustDo: z.array(z.string()),
      mustNotDo: z.array(z.string()),
      assumptions: z.array(z.string()),
    }),
    executionRules: z.object({
      toolDrivenOnly: z.boolean(),
      readBeforeWrite: z.boolean(),
      noSpeculativeChanges: z.boolean(),
      preferSmallScopedFixes: z.boolean(),
      avoidUnrelatedRefactors: z.boolean(),
      batchRelatedComments: z.boolean(),
      resolveThreadsOnlyAfterProof: z.boolean(),
    }),
    loopPolicy: z.object({
      prioritizeCiFailuresFirst: z.boolean(),
      maxIterations: z.number().int().nonnegative(),
      stopWhen: z.object({
        ciPassing: z.boolean(),
        noUnresolvedThreads: z.boolean(),
      }),
    }),
    successDefinition: z.object({
      functional: z.array(z.string()),
      verification: z.array(z.string()),
      review: z.array(z.string()),
    }),
    suggestedApproach: z.array(z.string()),
    threadStrategy: z.object({
      clusterThemes: z.array(
        z.object({
          theme: z.string().min(1),
          threadIds: z.array(z.string()),
          rationale: z.string().min(1),
        }),
      ),
      needsFullThreadFetch: z.array(z.string()),
      ignoreAsOutdated: z.array(z.string()),
    }),
  })
  .strict();

export const executionKickoffPromptSchema = promptEnvelopeSchema.merge(
  z.object({
    promptKind: z.literal('execution_kickoff'),
    body: executionKickoffBodySchema,
  }),
);

export const reviewRemediationPromptSchema = promptEnvelopeSchema.merge(
  z.object({
    promptKind: z.literal('review_remediation_kickoff'),
    body: reviewRemediationBodySchema,
  }),
);

export const promptSchemaByKind = {
  execution_kickoff: executionKickoffPromptSchema,
  review_remediation_kickoff: reviewRemediationPromptSchema,
};

export type ExecutionKickoffBody = z.infer<typeof executionKickoffBodySchema>;
export type ReviewRemediationBody = z.infer<typeof reviewRemediationBodySchema>;
