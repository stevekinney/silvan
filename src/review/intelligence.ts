import type { ReviewClassification, ReviewThreadSeverity } from '../agent/schemas';
import type { ReviewThreadFingerprint } from './planning';

export type ReviewSeverityAction = 'actionable' | 'ignore' | 'auto_resolve';

export type ReviewSeverityPolicy = Record<ReviewThreadSeverity, ReviewSeverityAction>;

export type ReviewSeveritySummary = Record<ReviewThreadSeverity, number>;

export type ReviewThreadPriority = {
  threadId: string;
  severity: ReviewThreadSeverity;
  summary?: string;
  path?: string | null;
  line?: number | null;
  isOutdated: boolean;
};

const DEFAULT_SEVERITY: ReviewThreadSeverity = 'suggestion';

const SEVERITY_ORDER: ReviewThreadSeverity[] = [
  'blocking',
  'question',
  'suggestion',
  'nitpick',
];

export function getSeverityOrder(): ReviewThreadSeverity[] {
  return [...SEVERITY_ORDER];
}

export function buildSeverityIndex(options: {
  classification: ReviewClassification;
  fingerprints: ReviewThreadFingerprint[];
}): {
  severityByThreadId: Record<string, ReviewThreadSeverity>;
  summaryByThreadId: Record<string, string>;
} {
  const severityByThreadId: Record<string, ReviewThreadSeverity> = {};
  const summaryByThreadId: Record<string, string> = {};

  if (options.classification.threads?.length) {
    for (const thread of options.classification.threads) {
      severityByThreadId[thread.threadId] = thread.severity;
      summaryByThreadId[thread.threadId] = thread.summary;
    }
  }

  for (const fingerprint of options.fingerprints) {
    if (!severityByThreadId[fingerprint.threadId]) {
      severityByThreadId[fingerprint.threadId] = inferSeverity(
        fingerprint.threadId,
        options.classification,
      );
    }
  }

  return { severityByThreadId, summaryByThreadId };
}

export function buildSeveritySummary(
  severityByThreadId: Record<string, ReviewThreadSeverity>,
): ReviewSeveritySummary {
  const summary: ReviewSeveritySummary = {
    blocking: 0,
    question: 0,
    suggestion: 0,
    nitpick: 0,
  };
  for (const severity of Object.values(severityByThreadId)) {
    summary[severity] += 1;
  }
  return summary;
}

export function applySeverityPolicy(options: {
  severityByThreadId: Record<string, ReviewThreadSeverity>;
  policy: ReviewSeverityPolicy;
}): {
  actionableThreadIds: string[];
  ignoredThreadIds: string[];
  autoResolveThreadIds: string[];
} {
  const actionableThreadIds: string[] = [];
  const ignoredThreadIds: string[] = [];
  const autoResolveThreadIds: string[] = [];

  for (const [threadId, severity] of Object.entries(options.severityByThreadId)) {
    const action = options.policy[severity] ?? 'actionable';
    if (action === 'auto_resolve') {
      autoResolveThreadIds.push(threadId);
    } else if (action === 'ignore') {
      ignoredThreadIds.push(threadId);
    } else {
      actionableThreadIds.push(threadId);
    }
  }

  return { actionableThreadIds, ignoredThreadIds, autoResolveThreadIds };
}

export function buildReviewPriorityList(options: {
  fingerprints: ReviewThreadFingerprint[];
  severityByThreadId: Record<string, ReviewThreadSeverity>;
  summaryByThreadId: Record<string, string>;
}): ReviewThreadPriority[] {
  const byId = new Map(options.fingerprints.map((thread) => [thread.threadId, thread]));
  const priorities: ReviewThreadPriority[] = [];

  for (const [threadId, severity] of Object.entries(options.severityByThreadId)) {
    const fingerprint = byId.get(threadId);
    const comment = fingerprint?.comments[0];
    priorities.push({
      threadId,
      severity,
      ...(options.summaryByThreadId[threadId]
        ? { summary: options.summaryByThreadId[threadId] }
        : {}),
      path: comment?.path ?? null,
      line: comment?.line ?? null,
      isOutdated: fingerprint?.isOutdated ?? false,
    });
  }

  priorities.sort((a, b) => {
    const orderA = SEVERITY_ORDER.indexOf(a.severity);
    const orderB = SEVERITY_ORDER.indexOf(b.severity);
    if (orderA !== orderB) return orderA - orderB;
    return a.threadId.localeCompare(b.threadId);
  });

  return priorities;
}

function inferSeverity(
  threadId: string,
  classification: ReviewClassification,
): ReviewThreadSeverity {
  if (classification.ignoredThreadIds.includes(threadId)) return 'nitpick';
  if (classification.needsContextThreadIds.includes(threadId)) return 'question';
  if (classification.actionableThreadIds.includes(threadId)) return 'suggestion';
  return DEFAULT_SEVERITY;
}
