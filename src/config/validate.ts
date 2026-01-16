import { SilvanError } from '../core/errors';
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

export function resolveGitHubToken(config: Config): string | undefined {
  return config.github.token;
}

export function requireGitHubAuth(config: Config): string {
  const token = resolveGitHubToken(config);
  if (!token) {
    throw new SilvanError({
      code: 'auth.github.missing_token',
      message:
        'Missing GitHub token (configure github.token or set GITHUB_TOKEN/GH_TOKEN).',
      userMessage: 'Missing GitHub token.',
      kind: 'auth',
      nextSteps: [
        'Set GITHUB_TOKEN or GH_TOKEN in your environment.',
        'Or configure github.token in silvan.config.ts.',
      ],
    });
  }
  return token;
}

export function resolveLinearToken(config: Config): string | undefined {
  return config.linear.token;
}

export function requireLinearAuth(config: Config): string {
  const token = resolveLinearToken(config);
  if (!token) {
    throw new SilvanError({
      code: 'auth.linear.missing_token',
      message: 'Missing Linear token (configure linear.token or set LINEAR_API_KEY).',
      userMessage: 'Missing Linear token.',
      kind: 'auth',
      nextSteps: [
        'Set LINEAR_API_KEY in your environment.',
        'Or configure linear.token in silvan.config.ts.',
      ],
    });
  }
  return token;
}
