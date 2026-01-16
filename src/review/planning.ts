import { hashString } from '../utils/hash';

export type ReviewThreadFingerprint = {
  threadId: string;
  comments: Array<{
    id: string;
    path: string | null;
    line: number | null;
    bodyDigest: string;
    excerpt?: string;
  }>;
  isOutdated: boolean;
};

export type ReviewThreadDetails = {
  threadId: string;
  comments: Array<{
    id: string;
    path: string | null;
    line: number | null;
    body: string;
    url?: string | null;
  }>;
  isOutdated: boolean;
};

export type ReviewThreadContext = {
  threadId: string;
  comments: Array<{
    id: string;
    path: string | null;
    line: number | null;
    bodyDigest: string;
    body?: string;
    excerpt?: string;
  }>;
  isOutdated: boolean;
};

export function selectThreadsForContext(options: {
  fingerprints: ReviewThreadFingerprint[];
  needsContextThreadIds: string[];
}): string[] {
  const known = new Set(options.fingerprints.map((thread) => thread.threadId));
  return options.needsContextThreadIds.filter((threadId) => known.has(threadId));
}

export function buildReviewPlanThreads(options: {
  fingerprints: ReviewThreadFingerprint[];
  detailedThreads: ReviewThreadDetails[];
  actionableThreadIds: string[];
  ignoredThreadIds: string[];
}): ReviewThreadContext[] {
  const byId = options.fingerprints.reduce<Record<string, ReviewThreadFingerprint>>(
    (acc, thread) => {
      acc[thread.threadId] = thread;
      return acc;
    },
    {},
  );
  const detailedById = options.detailedThreads.reduce<
    Record<string, ReviewThreadDetails>
  >((acc, thread) => {
    acc[thread.threadId] = thread;
    return acc;
  }, {});
  const planThreadIds = new Set([
    ...options.actionableThreadIds,
    ...options.ignoredThreadIds,
  ]);

  const result: ReviewThreadContext[] = [];
  for (const threadId of planThreadIds) {
    const fingerprint = byId[threadId];
    if (!fingerprint) continue;
    const detailed = detailedById[threadId];
    const comments = detailed
      ? detailed.comments.map((comment) => ({
          id: comment.id,
          path: comment.path,
          line: comment.line,
          bodyDigest: hashString(comment.body),
          body: comment.body,
        }))
      : fingerprint.comments.map((comment) => ({
          id: comment.id,
          path: comment.path,
          line: comment.line,
          bodyDigest: comment.bodyDigest,
          ...(comment.excerpt ? { excerpt: comment.excerpt } : {}),
        }));
    result.push({
      threadId,
      isOutdated: detailed ? detailed.isOutdated : fingerprint.isOutdated,
      comments,
    });
  }
  return result;
}
