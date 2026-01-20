import PQueue from 'p-queue';

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
