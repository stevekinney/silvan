import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type PathsProvider, resolveAppPaths } from './paths';

export type OnboardingState = {
  firstRunCompleted?: boolean;
  quickstartCompleted?: boolean;
  lastVersion?: string;
};

export type OnboardingStoreOptions = {
  provider?: PathsProvider;
  root?: string;
  pathImpl?: Pick<typeof import('node:path'), 'join' | 'dirname'>;
};

export function resolveOnboardingPath(options?: OnboardingStoreOptions): string {
  const joinPath = options?.pathImpl?.join ?? join;
  const dataRoot = options?.root ?? resolveAppPaths(options?.provider).data;
  return joinPath(dataRoot, 'state.json');
}

export async function loadOnboardingState(
  options?: OnboardingStoreOptions,
): Promise<OnboardingState> {
  const path = resolveOnboardingPath(options);
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as OnboardingState;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function updateOnboardingState(
  update: OnboardingState,
  options?: OnboardingStoreOptions,
): Promise<OnboardingState> {
  const path = resolveOnboardingPath(options);
  const current = await loadOnboardingState(options);
  const next: OnboardingState = {
    ...current,
    ...update,
  };
  await writeJsonAtomic(path, next, options);
  return next;
}

export async function markFirstRunCompleted(
  version: string,
  options?: OnboardingStoreOptions,
): Promise<OnboardingState> {
  return updateOnboardingState(
    { firstRunCompleted: true, lastVersion: version },
    options,
  );
}

export async function markQuickstartCompleted(
  version: string,
  options?: OnboardingStoreOptions,
): Promise<OnboardingState> {
  return updateOnboardingState(
    { quickstartCompleted: true, firstRunCompleted: true, lastVersion: version },
    options,
  );
}

async function writeJsonAtomic(
  path: string,
  payload: OnboardingState,
  options?: OnboardingStoreOptions,
): Promise<void> {
  const dir = options?.pathImpl?.dirname ?? dirname;
  const joinPath = options?.pathImpl?.join ?? join;
  await mkdir(dir(path), { recursive: true });
  const temp = joinPath(dir(path), `${crypto.randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
  await rename(temp, path);
}
