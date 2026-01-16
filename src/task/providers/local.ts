import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StateStore } from '../../state/store';
import { hashString } from '../../utils/hash';
import { sanitizeName } from '../../utils/slug';
import type { Task } from '../types';
import {
  extractAcceptanceCriteria,
  extractChecklistItems,
  normalizeCriteria,
} from '../utils';

export type LocalTaskInput = {
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  labels?: string[];
};

function buildLocalKey(seed: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const short = hashString(seed).slice(0, 6).toUpperCase();
  return `LOCAL-${date}-${short}`;
}

async function readTaskFile(path: string): Promise<Task | null> {
  try {
    const raw = await Bun.file(path).text();
    return JSON.parse(raw) as Task;
  } catch {
    return null;
  }
}

export async function loadLocalTask(state: StateStore, idOrKey: string): Promise<Task> {
  const directPath = join(state.tasksDir, `${sanitizeName(idOrKey)}.json`);
  const direct = await readTaskFile(directPath);
  if (direct) return direct;

  let entries: string[] = [];
  try {
    entries = await readdir(state.tasksDir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const task = await readTaskFile(join(state.tasksDir, entry));
    if (!task) continue;
    if (task.key === idOrKey || task.id === idOrKey) {
      return task;
    }
  }
  throw new Error(`Local task not found: ${idOrKey}`);
}

export async function createLocalTask(options: {
  state: StateStore;
  runId?: string;
  input: LocalTaskInput;
}): Promise<Task> {
  if (options.runId) {
    const existingRun = await options.state.readRunState(options.runId);
    const existingTask = existingRun?.data?.['task'] as Task | undefined;
    if (existingTask?.provider === 'local') {
      return existingTask;
    }
  }

  const id = crypto.randomUUID();
  const key = buildLocalKey(`${options.input.title}-${id}`);
  const task: Task = {
    id,
    key,
    provider: 'local',
    title: options.input.title,
    description: options.input.description ?? '',
    acceptanceCriteria: normalizeCriteria(options.input.acceptanceCriteria ?? []),
    labels: options.input.labels ?? [],
  };

  await mkdir(options.state.tasksDir, { recursive: true });
  const path = join(options.state.tasksDir, `${sanitizeName(id)}.json`);
  const payload = JSON.stringify(task, null, 2);
  const temp = join(
    options.state.tasksDir,
    `${sanitizeName(id)}.${crypto.randomUUID()}.tmp`,
  );
  await writeFile(temp, payload, 'utf8');
  await rename(temp, path);

  return task;
}

export function parseLocalTaskFile(contents: string): LocalTaskInput {
  const lines = contents.split('\n');
  const firstNonEmpty = lines.findIndex((line) => line.trim().length > 0);
  const titleLine =
    firstNonEmpty >= 0 ? (lines[firstNonEmpty]?.trim() ?? '') : 'Untitled Task';
  const title = titleLine.replace(/^#\s*/, '').trim() || 'Untitled Task';
  const description = lines
    .slice(firstNonEmpty + 1)
    .join('\n')
    .trim();
  const acceptanceCriteria = normalizeCriteria([
    ...extractAcceptanceCriteria(contents),
    ...extractChecklistItems(contents),
  ]);

  return {
    title,
    ...(description ? { description } : {}),
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
  };
}
