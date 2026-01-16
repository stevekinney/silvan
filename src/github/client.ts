import { Octokit } from 'octokit';

export function getGitHubToken(): string {
  const token = Bun.env['GITHUB_TOKEN'] ?? Bun.env['GH_TOKEN'];
  if (!token) {
    throw new Error(
      'Missing GitHub token (configure github.token or set GITHUB_TOKEN/GH_TOKEN).',
    );
  }
  return token;
}

export function createOctokit(token?: string): Octokit {
  const auth = token ?? getGitHubToken();
  return new Octokit({ auth });
}
