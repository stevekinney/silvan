import { Octokit } from 'octokit';

export function getGitHubToken(): string {
  const token = Bun.env['GITHUB_TOKEN'] ?? Bun.env['GH_TOKEN'];
  if (!token) {
    throw new Error('Missing GITHUB_TOKEN or GH_TOKEN');
  }
  return token;
}

export function createOctokit(): Octokit {
  const auth = getGitHubToken();
  return new Octokit({ auth });
}
