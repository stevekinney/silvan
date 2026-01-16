import { join } from 'node:path';

import envPaths from 'env-paths';

import { hashString } from '../utils/hash';

export type StateMode = 'global' | 'repo';

export type AppPaths = {
  data: string;
  cache: string;
  config: string;
  log: string;
  temp: string;
};

export type PathsProvider = (name: string) => AppPaths;

export type StatePaths = {
  mode: StateMode;
  repoId: string;
  root: string;
  dataRoot: string;
  cacheRoot: string;
  runsDir: string;
  auditDir: string;
  cacheDir: string;
  conversationsDir: string;
  artifactsDir: string;
  tasksDir: string;
  metadataPath: string;
};

export function resolveAppPaths(provider: PathsProvider = envPaths): AppPaths {
  return provider('silvan');
}

export function resolveStatePaths(options: {
  repoRoot: string;
  mode: StateMode;
  stateRoot?: string;
  repoId?: string;
  provider?: PathsProvider;
  pathImpl?: Pick<typeof import('node:path'), 'join'>;
}): StatePaths {
  const repoId = options.repoId ?? hashString(options.repoRoot);
  const joinPath = options.pathImpl?.join ?? join;
  if (options.mode === 'repo') {
    const root = joinPath(options.repoRoot, '.silvan');
    return {
      mode: 'repo',
      repoId,
      root,
      dataRoot: root,
      cacheRoot: root,
      runsDir: joinPath(root, 'runs'),
      auditDir: joinPath(root, 'audit'),
      cacheDir: joinPath(root, 'cache'),
      conversationsDir: joinPath(root, 'conversations'),
      artifactsDir: joinPath(root, 'artifacts'),
      tasksDir: joinPath(root, 'tasks'),
      metadataPath: joinPath(root, 'metadata.json'),
    };
  }

  const appPaths = resolveAppPaths(options.provider);
  const dataRoot = options.stateRoot ?? appPaths.data;
  const cacheRoot = options.stateRoot
    ? joinPath(options.stateRoot, 'cache')
    : appPaths.cache;
  const repoRoot = joinPath(dataRoot, 'repos', repoId);

  return {
    mode: 'global',
    repoId,
    root: repoRoot,
    dataRoot,
    cacheRoot,
    runsDir: joinPath(repoRoot, 'runs'),
    auditDir: joinPath(repoRoot, 'audit'),
    cacheDir: joinPath(cacheRoot, 'repos', repoId),
    conversationsDir: joinPath(repoRoot, 'conversations'),
    artifactsDir: joinPath(repoRoot, 'artifacts'),
    tasksDir: joinPath(repoRoot, 'tasks'),
    metadataPath: joinPath(repoRoot, 'metadata.json'),
  };
}
