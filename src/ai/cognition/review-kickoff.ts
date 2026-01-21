import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';
import { z } from 'zod';

import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import {
  hashInputs,
  hashPrompt,
  renderPromptSummary,
  validatePrompt,
} from '../../prompts';
import {
  type ReviewRemediationBody,
  reviewRemediationPromptSchema,
} from '../../prompts/schema';
import type { ReviewRemediationPrompt } from '../../prompts/types';
import type { Task } from '../../task/types';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';

type ReviewRemediationBodyInput = Record<string, unknown> | null;
type ReviewRemediationClient = Parameters<
  typeof invokeCognition<ReviewRemediationBodyInput>
>[0]['client'];

const reviewRemediationBodyLooseSchema = z.object({}).passthrough();

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
  invoke?: typeof invokeCognition;
  client?: ReviewRemediationClient;
}): Promise<ReviewRemediationPrompt> {
  const fallbackBody = buildReviewRemediationFallback({
    task: input.task,
    pr: input.pr,
    review: input.review,
    ci: input.ci,
    repo: input.repo,
    config: input.config,
  });
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

  const invoke = input.invoke ?? invokeCognition;
  const body = await invoke<ReviewRemediationBodyInput>({
    snapshot,
    task: 'reviewKickoff',
    schema: reviewRemediationBodyLooseSchema,
    config: input.config,
    ...(input.client ? { client: input.client } : {}),
    ...(input.bus ? { bus: input.bus } : {}),
    ...(input.context ? { context: input.context } : {}),
  }).catch(() => null);

  const normalizedBody = normalizeReviewRemediationBody(body, fallbackBody);

  const envelope: ReviewRemediationPrompt = {
    promptVersion: '1.0',
    promptKind: 'review_remediation_kickoff',
    createdAt: new Date().toISOString(),
    source: 'silvan',
    id: crypto.randomUUID(),
    inputsDigest,
    body: normalizedBody,
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

type ReviewRemediationFallbackInput = {
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
  config: Config;
};

function buildReviewRemediationFallback(
  input: ReviewRemediationFallbackInput,
): ReviewRemediationBody {
  const taskKey = input.task.key ?? input.task.id;
  const acceptanceCriteria = normalizeFallbackList(input.task.acceptanceCriteria, [
    input.task.title,
  ]);
  const verification = normalizeFallbackList(input.repo.verificationCommands, [
    'Run verification commands',
  ]);
  const reviewThreadIds = input.review.threadFingerprints.map(
    (thread) => thread.threadId,
  );
  const outdatedThreadIds = input.review.threadFingerprints
    .filter((thread) => thread.isOutdated)
    .map((thread) => thread.threadId);
  const maxIterations = normalizeIterationCount(input.config.review.maxIterations, 2);

  return {
    objective: `Resolve review feedback for ${input.task.title}`,
    context: {
      task: {
        key: taskKey,
        title: input.task.title,
        acceptanceCriteria,
      },
      pr: {
        id: input.pr.id,
        ...(input.pr.url ? { url: input.pr.url } : {}),
        branch: input.pr.branch,
      },
      review: {
        unresolvedThreadCount: input.review.unresolvedThreadCount,
        threadFingerprints: input.review.threadFingerprints,
      },
      ci: {
        state: input.ci.state,
        ...(input.ci.summary ? { summary: input.ci.summary } : {}),
        failedChecks: input.ci.failedChecks,
      },
      repo: {
        frameworks: input.repo.frameworks,
        verificationCommands: input.repo.verificationCommands,
      },
    },
    constraints: {
      mustDo: ['Address unresolved review feedback'],
      mustNotDo: ['Avoid unrelated refactors'],
      assumptions: ['Review context limited to the provided threads'],
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
      maxIterations,
      stopWhen: {
        ciPassing: true,
        noUnresolvedThreads: true,
      },
    },
    successDefinition: {
      functional: acceptanceCriteria,
      verification,
      review: ['Resolve all review threads'],
    },
    suggestedApproach: [
      'Review unresolved threads and CI status',
      'Apply targeted fixes',
      'Run verification commands',
      'Resolve threads after confirmation',
    ],
    threadStrategy: {
      clusterThemes: [],
      needsFullThreadFetch: reviewThreadIds,
      ignoreAsOutdated: outdatedThreadIds,
    },
  };
}

export function normalizeReviewRemediationBody(
  candidate: ReviewRemediationBodyInput,
  fallback: ReviewRemediationBody,
): ReviewRemediationBody {
  const input = candidate ?? {};
  const constraints = asRecord(input['constraints']);
  const executionRules = asRecord(input['executionRules']);
  const loopPolicy = asRecord(input['loopPolicy']);
  const stopWhen = asRecord(loopPolicy?.['stopWhen']);
  const successDefinition = asRecord(input['successDefinition']);
  const threadStrategy = asRecord(input['threadStrategy']);

  const normalized: ReviewRemediationBody = {
    objective: coerceString(input['objective'], fallback.objective),
    context: fallback.context,
    constraints: {
      mustDo: coerceStringList(constraints?.['mustDo'], fallback.constraints.mustDo),
      mustNotDo: coerceStringList(
        constraints?.['mustNotDo'],
        fallback.constraints.mustNotDo,
      ),
      assumptions: coerceStringList(
        constraints?.['assumptions'],
        fallback.constraints.assumptions,
      ),
    },
    executionRules: {
      toolDrivenOnly: coerceBoolean(
        executionRules?.['toolDrivenOnly'],
        fallback.executionRules.toolDrivenOnly,
      ),
      readBeforeWrite: coerceBoolean(
        executionRules?.['readBeforeWrite'],
        fallback.executionRules.readBeforeWrite,
      ),
      noSpeculativeChanges: coerceBoolean(
        executionRules?.['noSpeculativeChanges'],
        fallback.executionRules.noSpeculativeChanges,
      ),
      preferSmallScopedFixes: coerceBoolean(
        executionRules?.['preferSmallScopedFixes'],
        fallback.executionRules.preferSmallScopedFixes,
      ),
      avoidUnrelatedRefactors: coerceBoolean(
        executionRules?.['avoidUnrelatedRefactors'],
        fallback.executionRules.avoidUnrelatedRefactors,
      ),
      batchRelatedComments: coerceBoolean(
        executionRules?.['batchRelatedComments'],
        fallback.executionRules.batchRelatedComments,
      ),
      resolveThreadsOnlyAfterProof: coerceBoolean(
        executionRules?.['resolveThreadsOnlyAfterProof'],
        fallback.executionRules.resolveThreadsOnlyAfterProof,
      ),
    },
    loopPolicy: {
      prioritizeCiFailuresFirst: coerceBoolean(
        loopPolicy?.['prioritizeCiFailuresFirst'],
        fallback.loopPolicy.prioritizeCiFailuresFirst,
      ),
      maxIterations: normalizeIterationCount(
        loopPolicy?.['maxIterations'],
        fallback.loopPolicy.maxIterations,
      ),
      stopWhen: {
        ciPassing: coerceBoolean(
          stopWhen?.['ciPassing'],
          fallback.loopPolicy.stopWhen.ciPassing,
        ),
        noUnresolvedThreads: coerceBoolean(
          stopWhen?.['noUnresolvedThreads'],
          fallback.loopPolicy.stopWhen.noUnresolvedThreads,
        ),
      },
    },
    successDefinition: {
      functional: coerceStringList(
        successDefinition?.['functional'],
        fallback.successDefinition.functional,
      ),
      verification: coerceStringList(
        successDefinition?.['verification'],
        fallback.successDefinition.verification,
      ),
      review: coerceStringList(
        successDefinition?.['review'],
        fallback.successDefinition.review,
      ),
    },
    suggestedApproach: coerceStringList(
      input['suggestedApproach'],
      fallback.suggestedApproach,
    ),
    threadStrategy: {
      clusterThemes: normalizeClusterThemes(
        threadStrategy?.['clusterThemes'],
        fallback.threadStrategy.clusterThemes,
      ),
      needsFullThreadFetch: coerceStringList(
        threadStrategy?.['needsFullThreadFetch'],
        fallback.threadStrategy.needsFullThreadFetch,
      ),
      ignoreAsOutdated: coerceStringList(
        threadStrategy?.['ignoreAsOutdated'],
        fallback.threadStrategy.ignoreAsOutdated,
      ),
    },
  };

  return reviewRemediationPromptSchema.shape.body.parse(normalized);
}

function normalizeClusterThemes(
  value: unknown,
  fallback: ReviewRemediationBody['threadStrategy']['clusterThemes'],
): ReviewRemediationBody['threadStrategy']['clusterThemes'] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value.reduce<
    ReviewRemediationBody['threadStrategy']['clusterThemes']
  >((acc, entry) => {
    const record = asRecord(entry);
    if (!record) return acc;
    const theme = coerceString(record['theme'], '');
    const rationale = coerceString(record['rationale'], '');
    const threadIds = coerceStringList(record['threadIds'], []);
    if (!theme || !rationale || threadIds.length === 0) {
      return acc;
    }
    acc.push({ theme, rationale, threadIds });
    return acc;
  }, []);
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeIterationCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeFallbackList(items: string[], fallback: string[]): string[] {
  const normalized = items.map((item) => item.trim()).filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function coerceString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function coerceStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const trimmed = value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return trimmed.length > 0 ? trimmed : fallback;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}
