import { basename } from 'node:path';

import type { Config } from '../config/schema';

export type RepoLabelOptions = {
  includeHost?: boolean;
  fallback?: 'path' | 'basename';
};

export function formatRepoLabel(
  config: Config,
  repoRoot: string,
  options?: RepoLabelOptions,
): string {
  if (config.github.owner && config.github.repo) {
    const label = `${config.github.owner}/${config.github.repo}`;
    return options?.includeHost === false ? label : `github.com/${label}`;
  }
  if (options?.fallback === 'basename') {
    const name = basename(repoRoot);
    return name.length > 0 ? name : repoRoot;
  }
  return repoRoot;
}
