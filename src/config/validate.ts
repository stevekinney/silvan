import type { Config } from './schema';

export function requireGitHubConfig(config: Config): { owner: string; repo: string } {
  if (config.github.owner && config.github.repo) {
    return { owner: config.github.owner, repo: config.github.repo };
  }

  throw new Error('GitHub owner/repo must be configured');
}

export function requireGitHubAuth(): void {
  if (!process.env['GITHUB_TOKEN'] && !process.env['GH_TOKEN']) {
    throw new Error('Missing GITHUB_TOKEN or GH_TOKEN');
  }
}
