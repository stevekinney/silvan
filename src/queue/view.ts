import type { Config } from '../config/schema';
import type { QueueRequest } from '../state/queue';
import { applyQueuePriority } from './priority';

export type QueueRequestView = {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority: number;
  effectivePriority: number;
  priorityBoost: number;
  priorityTier: 'high' | 'medium' | 'low';
  ageMinutes: number;
  createdAt: string;
};

export function buildQueueRequestView(
  request: QueueRequest,
  config: Config,
  nowMs = Date.now(),
): QueueRequestView {
  const priorityInfo = applyQueuePriority(request, config, nowMs);
  return {
    id: request.id,
    title: request.title,
    ...(request.description ? { description: request.description } : {}),
    ...(request.acceptanceCriteria
      ? { acceptanceCriteria: request.acceptanceCriteria }
      : {}),
    priority: priorityInfo.basePriority,
    effectivePriority: priorityInfo.effectivePriority,
    priorityBoost: priorityInfo.priorityBoost,
    priorityTier: priorityInfo.priorityTier,
    ageMinutes: priorityInfo.ageMinutes,
    createdAt: request.createdAt,
  };
}
