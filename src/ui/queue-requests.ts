import type { Config } from '../config/schema';
import { writeQueueRequest } from '../state/queue';
import type { StateStore } from '../state/store';
import { type DashboardScope, loadQueueRequests, type RunSnapshotCache } from './loader';
import type { QueueRecord } from './types';

export async function enqueueQueueRequest(options: {
  state: StateStore;
  config: Config;
  cache?: RunSnapshotCache;
  scope: DashboardScope;
  title: string;
  description?: string;
  priority?: number;
}): Promise<QueueRecord[]> {
  const title = options.title.trim();
  if (!title) {
    return loadQueueRequests(options.state, options.config, {
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
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      createdAt: new Date().toISOString(),
    },
  });

  return loadQueueRequests(options.state, options.config, {
    ...(options.cache ? { cache: options.cache } : {}),
    scope: options.scope,
  });
}
