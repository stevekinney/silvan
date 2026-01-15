import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { runGit } from '../git/exec';
import type { Config } from './schema';

type GitHubOwnerRepo = { owner: string; repo: string };
type GitHubRepo = GitHubOwnerRepo & { source: 'config' | 'origin' };

function parseGitHubRemote(remoteUrl: string): GitHubOwnerRepo | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/, '');

  let match = cleaned.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (match) return { owner: match[1]!, repo: match[2]! };

  match = cleaned.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/);
  if (match) return { owner: match[1]!, repo: match[2]! };

  match = cleaned.match(/^https:\/\/github\.com\/([^/]+)\/(.+)$/);
  if (match) return { owner: match[1]!, repo: match[2]! };

  return null;
}

export async function requireGitHubConfig(options: {
  config: Config;
  repoRoot: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<GitHubRepo> {
  if (options.config.github.owner && options.config.github.repo) {
    return {
      owner: options.config.github.owner,
      repo: options.config.github.repo,
      source: 'config',
    };
  }

  const result = await runGit(['remote', 'get-url', 'origin'], {
    cwd: options.repoRoot,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(
      'GitHub owner/repo must be configured or derivable from origin remote.',
    );
  }

  const parsed = parseGitHubRemote(result.stdout);
  if (!parsed) {
    throw new Error(
      'Unable to parse GitHub owner/repo from origin remote. Configure github.owner and github.repo.',
    );
  }

  return { ...parsed, source: 'origin' };
}

export function requireGitHubAuth(): void {
  if (!Bun.env['GITHUB_TOKEN'] && !Bun.env['GH_TOKEN']) {
    throw new Error(
      'Missing GITHUB_TOKEN or GH_TOKEN (needs repo scopes for private repositories).',
    );
  }
}
