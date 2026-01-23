import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sanitizeName } from '../utils/slug';
import type { StateStore } from './store';

export type QueueRequest = {
  id: string;
  type: 'start-task';
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: number;
  createdAt: string;
  updatedAt?: string;
};

export async function writeQueueRequest(options: {
  state: StateStore;
  request: QueueRequest;
}): Promise<string> {
  await mkdir(options.state.queueDir, { recursive: true });
  const file = `${sanitizeName(options.request.id)}.json`;
  const path = join(options.state.queueDir, file);
  const temp = join(
    options.state.queueDir,
    `${sanitizeName(options.request.id)}.${crypto.randomUUID()}.tmp`,
  );
  const payload = JSON.stringify(options.request, null, 2);
  await writeFile(temp, payload, 'utf8');
  await rename(temp, path);
  return path;
}

export async function listQueueRequestsInDir(queueDir: string): Promise<QueueRequest[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(queueDir);
  } catch {
    return [];
  }
  const requests: QueueRequest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await Bun.file(join(queueDir, entry)).text();
      requests.push(JSON.parse(raw) as QueueRequest);
    } catch {
      // skip invalid entries
    }
  }
  return requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listQueueRequests(options: {
  state: StateStore;
}): Promise<QueueRequest[]> {
  return listQueueRequestsInDir(options.state.queueDir);
}

export async function deleteQueueRequest(options: {
  state: StateStore;
  requestId: string;
}): Promise<void> {
  const path = join(options.state.queueDir, `${sanitizeName(options.requestId)}.json`);
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

export async function getQueueRequest(options: {
  state: StateStore;
  requestId: string;
}): Promise<QueueRequest | null> {
  const path = join(options.state.queueDir, `${sanitizeName(options.requestId)}.json`);
  try {
    const raw = await Bun.file(path).text();
    return JSON.parse(raw) as QueueRequest;
  } catch {
    return null;
  }
}

export async function setQueueRequestPriority(options: {
  state: StateStore;
  requestId: string;
  priority: number;
}): Promise<QueueRequest | null> {
  const existing = await getQueueRequest(options);
  if (!existing) return null;
  const updated: QueueRequest = {
    ...existing,
    priority: options.priority,
    updatedAt: new Date().toISOString(),
  };
  await writeQueueRequest({ state: options.state, request: updated });
  return updated;
}
