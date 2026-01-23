import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LearningNotes } from '../learning/notes';
import { sanitizeName } from '../utils/slug';
import type { StateStore } from './store';

export type LearningRequestStatus = 'pending' | 'applied' | 'rejected' | 'rolled_back';

export type LearningRequest = {
  id: string;
  runId: string;
  status: LearningRequestStatus;
  createdAt: string;
  summary: string;
  confidence: number;
  threshold: number;
  notes: LearningNotes;
  targets: { rules?: string; skills?: string; docs?: string };
  updatedAt?: string;
  reason?: string;
  appliedAt?: string;
  rejectedAt?: string;
  rolledBackAt?: string;
  appliedTo?: string[];
  commitSha?: string;
};

export async function writeLearningRequest(options: {
  state: StateStore;
  request: LearningRequest;
}): Promise<string> {
  await mkdir(options.state.learningDir, { recursive: true });
  const file = `${sanitizeName(options.request.id)}.json`;
  const path = join(options.state.learningDir, file);
  const temp = join(
    options.state.learningDir,
    `${sanitizeName(options.request.id)}.${crypto.randomUUID()}.tmp`,
  );
  const payload = JSON.stringify(options.request, null, 2);
  await writeFile(temp, payload, 'utf8');
  await rename(temp, path);
  return path;
}

export async function listLearningRequests(options: {
  state: StateStore;
}): Promise<LearningRequest[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(options.state.learningDir);
  } catch {
    return [];
  }
  const requests: LearningRequest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await Bun.file(join(options.state.learningDir, entry)).text();
      requests.push(JSON.parse(raw) as LearningRequest);
    } catch {
      // skip invalid entries
    }
  }
  return requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function readLearningRequest(options: {
  state: StateStore;
  requestId: string;
}): Promise<LearningRequest | null> {
  const path = join(options.state.learningDir, `${sanitizeName(options.requestId)}.json`);
  try {
    const raw = await Bun.file(path).text();
    return JSON.parse(raw) as LearningRequest;
  } catch {
    return null;
  }
}

export async function deleteLearningRequest(options: {
  state: StateStore;
  requestId: string;
}): Promise<void> {
  const path = join(options.state.learningDir, `${sanitizeName(options.requestId)}.json`);
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}
