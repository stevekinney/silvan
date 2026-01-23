import { describe, expect, test } from 'bun:test';

import type { QueuePriorityTier } from './priority';
import { runPriorityQueueRequests, runQueueRequests } from './runner';

type TestRequest = { id: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runQueueRequests', () => {
  test('respects concurrency limits', async () => {
    const requests: TestRequest[] = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await runQueueRequests({
      requests,
      concurrency: 2,
      onRequest: async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) {
          maxInFlight = inFlight;
        }
        await sleep(20);
        inFlight -= 1;
      },
    });

    expect(result.succeeded).toBe(4);
    expect(result.failed).toBe(0);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  test('records failures and continues processing', async () => {
    const requests: TestRequest[] = ['a', 'b', 'c'].map((id) => ({ id }));
    let successCount = 0;

    const result = await runQueueRequests({
      requests,
      concurrency: 2,
      continueOnError: true,
      onRequest: async (request) => {
        if (request.id === 'b') {
          throw new Error('Boom');
        }
        successCount += 1;
      },
    });

    expect(successCount).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failures[0]?.id).toBe('b');
  });

  test('stops on the first failure when continueOnError is false', async () => {
    const requests: TestRequest[] = ['a', 'b', 'c'].map((id) => ({ id }));
    const seen: string[] = [];

    const result = await runQueueRequests({
      requests,
      concurrency: 1,
      onRequest: async (request) => {
        seen.push(request.id);
        if (request.id === 'b') {
          throw new Error('Boom');
        }
      },
    });

    expect(seen).toEqual(['a', 'b']);
    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
  });
});

describe('runPriorityQueueRequests', () => {
  test('respects tier concurrency', async () => {
    const requests = [
      { id: 'h1', priorityTier: 'high' as const },
      { id: 'h2', priorityTier: 'high' as const },
      { id: 'l1', priorityTier: 'low' as const },
      { id: 'l2', priorityTier: 'low' as const },
    ];
    const inFlight: Record<QueuePriorityTier, number> = {
      high: 0,
      medium: 0,
      low: 0,
    };
    const maxInFlight: Record<QueuePriorityTier, number> = {
      high: 0,
      medium: 0,
      low: 0,
    };

    const result = await runPriorityQueueRequests({
      requests,
      tierConcurrency: { high: 1, medium: 1, low: 1 },
      onRequest: async (request) => {
        const tier = request.priorityTier;
        inFlight[tier] += 1;
        if (inFlight[tier] > maxInFlight[tier]) {
          maxInFlight[tier] = inFlight[tier];
        }
        await sleep(20);
        inFlight[tier] -= 1;
      },
    });

    expect(result.succeeded).toBe(4);
    expect(result.failed).toBe(0);
    expect(maxInFlight['high']).toBeLessThanOrEqual(1);
    expect(maxInFlight['low']).toBeLessThanOrEqual(1);
  });
});
