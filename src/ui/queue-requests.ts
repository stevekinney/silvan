import { writeQueueRequest } from '../state/queue';
import type { StateStore } from '../state/store';
import { type DashboardScope, loadQueueRequests, type RunSnapshotCache } from './loader';
import type { QueueRecord } from './types';

export async function enqueueQueueRequest(options: {
  state: StateStore;
  cache?: RunSnapshotCache;
  scope: DashboardScope;
  title: string;
  description?: string;
}): Promise<QueueRecord[]> {
  const title = options.title.trim();
  if (!title) {
    return loadQueueRequests(options.state, {
      ...(options.cache ? { cache: options.cache } : {}),
      scope: options.scope,
    });
  }

  const description = options.description?.trim();
  await writeQueueRequest({
    state: options.state,
    request: {
      id: crypto.randomUUID(),
      type: 'start-task',
      title,
      ...(description ? { description } : {}),
      createdAt: new Date().toISOString(),
    },
  });

  return loadQueueRequests(options.state, {
    ...(options.cache ? { cache: options.cache } : {}),
    scope: options.scope,
  });
}
