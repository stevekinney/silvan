import { Octokit } from 'octokit';

import { readEnvValue } from '../utils/env';

export function getGitHubToken(): string {
  const token = readEnvValue('GITHUB_TOKEN') ?? readEnvValue('GH_TOKEN');
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
