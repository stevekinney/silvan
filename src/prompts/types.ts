import type { z } from 'zod';

import type {
  executionKickoffPromptSchema,
  reviewRemediationPromptSchema,
} from './schema';

export type ExecutionKickoffPrompt = z.infer<typeof executionKickoffPromptSchema>;
export type ReviewRemediationPrompt = z.infer<typeof reviewRemediationPromptSchema>;

export type PromptEnvelope = ExecutionKickoffPrompt | ReviewRemediationPrompt;
