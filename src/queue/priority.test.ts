import { describe, expect, test } from 'bun:test';

import { configSchema } from '../config/schema';
import type { QueueRequest } from '../state/queue';
import { applyQueuePriority } from './priority';

describe('queue priority', () => {
  test('defaults to configured priority', () => {
    const config = configSchema.parse({});
    const request: QueueRequest = {
      id: 'req-1',
      type: 'start-task',
      title: 'Ship it',
      createdAt: new Date().toISOString(),
    };
    const snapshot = applyQueuePriority(request, config);
    expect(snapshot.priority).toBe(5);
    expect(snapshot.effectivePriority).toBe(5);
    expect(snapshot.priorityTier).toBe('medium');
  });

  test('escalates priority after the threshold', () => {
    const config = configSchema.parse({});
    const nowMs = Date.now();
    const createdAt = new Date(nowMs - 90 * 60 * 1000).toISOString();
    const request: QueueRequest = {
      id: 'req-2',
      type: 'start-task',
      title: 'High urgency',
      createdAt,
    };
    const snapshot = applyQueuePriority(request, config, nowMs);
    expect(snapshot.priorityBoost).toBe(3);
    expect(snapshot.effectivePriority).toBe(8);
    expect(snapshot.priorityTier).toBe('high');
  });
});
