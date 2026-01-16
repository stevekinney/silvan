import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hashString } from '../utils/hash';
import { sanitizeName } from '../utils/slug';
import type { StateStore } from './store';

export type ArtifactEntry = {
  stepId: string;
  name: string;
  path: string;
  digest: string;
  updatedAt: string;
  kind: 'json' | 'text';
};

export async function writeArtifact(options: {
  state: StateStore;
  runId: string;
  stepId: string;
  name: string;
  data: unknown;
}): Promise<ArtifactEntry> {
  const runId = sanitizeName(options.runId);
  const stepId = sanitizeName(options.stepId);
  const name = sanitizeName(options.name);
  const updatedAt = new Date().toISOString();
  const artifactDir = join(options.state.artifactsDir, runId, stepId);
  await mkdir(artifactDir, { recursive: true });

  const isText = typeof options.data === 'string';
  const kind: ArtifactEntry['kind'] = isText ? 'text' : 'json';
  const fileName = `${name}.${isText ? 'txt' : 'json'}`;
  const path = join(artifactDir, fileName);
  const payload = isText
    ? (options.data as string)
    : JSON.stringify(options.data ?? null, null, 2);
  const temp = join(
    artifactDir,
    `${name}.${crypto.randomUUID()}.${isText ? 'txt' : 'json'}.tmp`,
  );

  await writeFile(temp, payload, 'utf8');
  await rename(temp, path);

  return {
    stepId: options.stepId,
    name: options.name,
    path,
    digest: hashString(payload),
    updatedAt,
    kind,
  };
}

export async function readArtifact<T = unknown>(options: {
  entry: ArtifactEntry;
}): Promise<T> {
  const raw = await Bun.file(options.entry.path).text();
  if (options.entry.kind === 'text') {
    return raw as T;
  }
  return JSON.parse(raw) as T;
}

export async function listArtifacts(options: {
  state: StateStore;
  runId: string;
}): Promise<ArtifactEntry[]> {
  const state = await options.state.readRunState(options.runId);
  const data = (state?.data as Record<string, unknown>) ?? {};
  const index = data['artifactsIndex'] as
    | Record<string, Record<string, ArtifactEntry>>
    | undefined;
  if (!index) return [];

  return Object.values(index).flatMap((entries) => Object.values(entries));
}
