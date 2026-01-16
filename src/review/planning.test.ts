import { describe, expect, it } from 'bun:test';

import { buildReviewPlanThreads, selectThreadsForContext } from './planning';

describe('review planning helpers', () => {
  it('selects only known threads for full context', () => {
    const fingerprints = [
      {
        threadId: 't1',
        isOutdated: false,
        comments: [
          {
            id: 'c1',
            path: null,
            line: null,
            bodyDigest: 'digest-1',
            excerpt: 'excerpt',
          },
        ],
      },
    ];
    const result = selectThreadsForContext({
      fingerprints,
      needsContextThreadIds: ['t1', 't2'],
    });
    expect(result).toEqual(['t1']);
  });

  it('builds plan threads using full bodies when available', () => {
    const fingerprints = [
      {
        threadId: 't1',
        isOutdated: false,
        comments: [
          {
            id: 'c1',
            path: null,
            line: null,
            bodyDigest: 'digest-1',
            excerpt: 'excerpt',
          },
        ],
      },
      {
        threadId: 't2',
        isOutdated: false,
        comments: [
          {
            id: 'c2',
            path: null,
            line: null,
            bodyDigest: 'digest-2',
            excerpt: 'excerpt-2',
          },
        ],
      },
    ];
    const detailedThreads = [
      {
        threadId: 't2',
        isOutdated: false,
        comments: [
          {
            id: 'c2',
            path: null,
            line: null,
            body: 'full body',
          },
        ],
      },
    ];

    const threads = buildReviewPlanThreads({
      fingerprints,
      detailedThreads,
      actionableThreadIds: ['t1', 't2'],
      ignoredThreadIds: [],
    });

    const t1 = threads.find((thread) => thread.threadId === 't1');
    const t2 = threads.find((thread) => thread.threadId === 't2');

    expect(t1?.comments[0]?.excerpt).toBe('excerpt');
    expect(t1?.comments[0]?.body).toBeUndefined();
    expect(t2?.comments[0]?.body).toBe('full body');
  });
});
