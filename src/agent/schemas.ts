import { z } from 'zod';

export const planStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  files: z.array(z.string()).optional(),
  verification: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  stopConditions: z.array(z.string()).optional(),
});

export const planSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(planStepSchema).min(1),
  verification: z.array(z.string()).min(1),
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        required: z.boolean().optional(),
      }),
    )
    .optional(),
});

export type Plan = z.infer<typeof planSchema>;

export const prDraftSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  checklist: z.array(z.string()).optional(),
  testing: z.array(z.string()).optional(),
  followUps: z.array(z.string()).optional(),
});

export type PrDraft = z.infer<typeof prDraftSchema>;

export const reviewFixPlanSchema = z.object({
  threads: z.array(
    z.object({
      threadId: z.string().min(1),
      actionable: z.boolean(),
      summary: z.string().min(1),
      comments: z.array(
        z.object({
          id: z.string().min(1),
          action: z.string().min(1),
        }),
      ),
    }),
  ),
  verification: z.array(z.string()).optional(),
  resolveThreads: z.array(z.string()).optional(),
});

export type ReviewFixPlan = z.infer<typeof reviewFixPlanSchema>;

export const reviewClassificationSchema = z.object({
  actionableThreadIds: z.array(z.string()),
  ignoredThreadIds: z.array(z.string()),
  needsContextThreadIds: z.array(z.string()),
  clusters: z
    .array(
      z.object({
        id: z.string().min(1),
        summary: z.string().min(1),
        threadIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .optional(),
});

export type ReviewClassification = z.infer<typeof reviewClassificationSchema>;

export const recoveryPlanSchema = z.object({
  nextAction: z.enum([
    'rerun_verification',
    'refetch_reviews',
    'restart_review_loop',
    'ask_user',
  ]),
  reason: z.string().min(1),
  steps: z.array(z.string()).optional(),
});

export type RecoveryPlan = z.infer<typeof recoveryPlanSchema>;
