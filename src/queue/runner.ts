import PQueue from 'p-queue';

import type { QueuePriorityTier } from './priority';

export type QueueRunFailure = {
  id: string;
  message: string;
};

export type QueueRunResult = {
  processed: number;
  succeeded: number;
  failed: number;
  failures: QueueRunFailure[];
};

export type QueueTierConcurrency = Record<QueuePriorityTier, number>;

export async function runQueueRequests<T extends { id: string }>(options: {
  requests: T[];
  concurrency: number;
  continueOnError?: boolean;
  onRequest: (request: T) => Promise<void>;
  onSuccess?: (request: T) => Promise<void>;
  onFailure?: (request: T, error: unknown) => Promise<void>;
}): Promise<QueueRunResult> {
  const concurrency = Math.floor(options.concurrency);
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(
      `Queue concurrency must be at least 1 (received ${options.concurrency}).`,
    );
  }

  if (options.requests.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, failures: [] };
  }

  const queue = new PQueue({ concurrency });
  const failures: QueueRunFailure[] = [];
  const continueOnError = options.continueOnError ?? false;
  let processed = 0;
  let succeeded = 0;
  let halted = false;

  for (const request of options.requests) {
    void queue.add(async () => {
      try {
        if (halted && !continueOnError) {
          return;
        }
        processed += 1;
        await options.onRequest(request);
        succeeded += 1;
        if (options.onSuccess) {
          await options.onSuccess(request);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ id: request.id, message });
        if (options.onFailure) {
          await options.onFailure(request, error);
        }
        if (!continueOnError) {
          halted = true;
          queue.clear();
        }
      }
    });
  }

  await queue.onIdle();

  return {
    processed,
    succeeded,
    failed: failures.length,
    failures,
  };
}

export async function runPriorityQueueRequests<
  T extends { id: string; priorityTier: QueuePriorityTier },
>(options: {
  requests: T[];
  tierConcurrency: QueueTierConcurrency;
  continueOnError?: boolean;
  onRequest: (request: T) => Promise<void>;
  onSuccess?: (request: T) => Promise<void>;
  onFailure?: (request: T, error: unknown) => Promise<void>;
}): Promise<QueueRunResult> {
  if (options.requests.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, failures: [] };
  }

  const queues: Record<QueuePriorityTier, PQueue> = {
    high: new PQueue({ concurrency: normalizeConcurrency(options.tierConcurrency.high) }),
    medium: new PQueue({
      concurrency: normalizeConcurrency(options.tierConcurrency.medium),
    }),
    low: new PQueue({ concurrency: normalizeConcurrency(options.tierConcurrency.low) }),
  };
  const failures: QueueRunFailure[] = [];
  const continueOnError = options.continueOnError ?? false;
  let processed = 0;
  let succeeded = 0;
  let halted = false;

  for (const request of options.requests) {
    const queue = queues[request.priorityTier];
    void queue.add(async () => {
      try {
        if (halted && !continueOnError) {
          return;
        }
        processed += 1;
        await options.onRequest(request);
        succeeded += 1;
        if (options.onSuccess) {
          await options.onSuccess(request);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ id: request.id, message });
        if (options.onFailure) {
          await options.onFailure(request, error);
        }
        if (!continueOnError) {
          halted = true;
          for (const queueToClear of Object.values(queues)) {
            queueToClear.clear();
          }
        }
      }
    });
  }

  await Promise.all(Object.values(queues).map((queue) => queue.onIdle()));

  return {
    processed,
    succeeded,
    failed: failures.length,
    failures,
  };
}

function normalizeConcurrency(value: number): number {
  const concurrency = Math.floor(value);
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(`Queue concurrency must be at least 1 (received ${value}).`);
  }
  return concurrency;
}
