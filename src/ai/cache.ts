import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ZodSchema } from 'zod';

import { hashString } from '../utils/hash';

export type AiCacheKey = {
  promptKind: string;
  inputsDigest: string;
  provider: string;
  model: string;
};

export type AiCacheEntry<T> = {
  promptKind: string;
  inputsDigest: string;
  provider: string;
  model: string;
  createdAt: string;
  content: T;
};

function cacheFilePath(cacheDir: string, key: AiCacheKey): string {
  const modelDigest = hashString(`${key.provider}:${key.model}`).slice(0, 8);
  const fileName = `${key.inputsDigest}-${modelDigest}.json`;
  return join(cacheDir, 'ai', key.promptKind, fileName);
}

export async function readAiCache<T>(options: {
  cacheDir: string;
  key: AiCacheKey;
  schema: ZodSchema<T>;
}): Promise<T | null> {
  const path = cacheFilePath(options.cacheDir, options.key);
  try {
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw) as AiCacheEntry<T>;
    if (
      parsed.promptKind !== options.key.promptKind ||
      parsed.inputsDigest !== options.key.inputsDigest ||
      parsed.provider !== options.key.provider ||
      parsed.model !== options.key.model
    ) {
      return null;
    }
    const validated = options.schema.safeParse(parsed.content);
    if (!validated.success) return null;
    return validated.data;
  } catch {
    return null;
  }
}

export async function writeAiCache<T>(options: {
  cacheDir: string;
  key: AiCacheKey;
  content: T;
}): Promise<string | null> {
  const path = cacheFilePath(options.cacheDir, options.key);
  try {
    await stat(path);
    return null;
  } catch {
    // ignore
  }
  await mkdir(dirname(path), { recursive: true });
  const entry: AiCacheEntry<T> = {
    promptKind: options.key.promptKind,
    inputsDigest: options.key.inputsDigest,
    provider: options.key.provider,
    model: options.key.model,
    createdAt: new Date().toISOString(),
    content: options.content,
  };
  const payload = JSON.stringify(entry, null, 2);
  const temp = join(
    dirname(path),
    `${options.key.inputsDigest}.${crypto.randomUUID()}.tmp`,
  );
  await writeFile(temp, payload, 'utf8');
  await rename(temp, path);
  return path;
}
