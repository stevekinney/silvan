import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import {
  hashInputs,
  hashPrompt,
  renderPromptSummary,
  validatePrompt,
} from '../../prompts';
import { reviewRemediationPromptSchema } from '../../prompts/schema';
import type { ReviewRemediationPrompt } from '../../prompts/types';
import type { Task } from '../../task/types';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';

export async function generateReviewRemediationKickoffPrompt(input: {
  task: Task;
  pr: { id: string; url?: string; branch: string };
  review: {
    unresolvedThreadCount: number;
    threadFingerprints: Array<{
      threadId: string;
      commentIds: string[];
      path: string | null;
      line?: number;
      isOutdated: boolean;
      bodyHash: string;
      excerpt?: string;
    }>;
  };
  ci: {
    state: 'unknown' | 'pending' | 'passing' | 'failing';
    summary?: string;
    failedChecks: string[];
  };
  repo: {
    frameworks: string[];
    verificationCommands: string[];
  };
  store: ConversationStore;
  config: Config;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<ReviewRemediationPrompt> {
  const inputsDigest = hashInputs({
    task: {
      key: input.task.key ?? input.task.id,
      title: input.task.title,
      acceptanceCriteria: input.task.acceptanceCriteria,
    },
    pr: input.pr,
    review: input.review,
    ci: input.ci,
    repo: input.repo,
  });

  const systemWriter = new ProseWriter();
  systemWriter.write('You are a prompt architect for review remediation.');
  systemWriter.write(
    'Generate a review remediation kickoff prompt body in JSON only, matching the required schema.',
  );
  systemWriter.write('Do not include full thread bodies or diffs.');

  const userWriter = new ProseWriter();
  userWriter.write(
    JSON.stringify(
      {
        task: {
          key: input.task.key ?? input.task.id,
          title: input.task.title,
          acceptanceCriteria: input.task.acceptanceCriteria,
        },
        pr: input.pr,
        review: input.review,
        ci: input.ci,
        repo: input.repo,
      },
      null,
      2,
    ),
  );

  const snapshot = await input.store.append([
    {
      role: 'system',
      content: systemWriter.toString().trimEnd(),
      metadata: { kind: 'review' },
    },
    {
      role: 'user',
      content: userWriter.toString().trimEnd(),
      metadata: { kind: 'review', protected: true },
    },
  ]);

  const body = await invokeCognition({
    snapshot,
    task: 'reviewKickoff',
    schema: reviewRemediationPromptSchema.shape.body,
    config: input.config,
    ...(input.bus ? { bus: input.bus } : {}),
    ...(input.context ? { context: input.context } : {}),
  });

  const envelope: ReviewRemediationPrompt = {
    promptVersion: '1.0',
    promptKind: 'review_remediation_kickoff',
    createdAt: new Date().toISOString(),
    source: 'silvan',
    id: crypto.randomUUID(),
    inputsDigest,
    body,
  };

  const validated = validatePrompt('review_remediation_kickoff', envelope);
  const promptDigest = hashPrompt(validated);
  const withSummary = appendMessages(snapshot.conversation, {
    role: 'assistant',
    content: `${renderPromptSummary(validated)} - ${promptDigest}`,
    metadata: { kind: 'review', protected: true },
  });
  await input.store.save(withSummary);

  return validated as ReviewRemediationPrompt;
}
