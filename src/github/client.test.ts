import { afterEach, describe, expect, it } from 'bun:test';

import { setEnvValue, unsetEnvValue } from '../utils/env';
import { createOctokit, getGitHubToken } from './client';

const ORIGINAL_GITHUB = Bun?.env?.['GITHUB_TOKEN'];
const ORIGINAL_GH = Bun?.env?.['GH_TOKEN'];

afterEach(() => {
  if (ORIGINAL_GITHUB) {
    setEnvValue('GITHUB_TOKEN', ORIGINAL_GITHUB);
  } else {
    unsetEnvValue('GITHUB_TOKEN');
  }
  if (ORIGINAL_GH) {
    setEnvValue('GH_TOKEN', ORIGINAL_GH);
  } else {
    unsetEnvValue('GH_TOKEN');
  }
});

describe('GitHub client helpers', () => {
  it('returns the GitHub token from environment', () => {
    setEnvValue('GITHUB_TOKEN', 'token-1');
    setEnvValue('GH_TOKEN', 'token-2');
    expect(getGitHubToken()).toBe('token-1');
  });

  it('falls back to GH_TOKEN when GITHUB_TOKEN is missing', () => {
    unsetEnvValue('GITHUB_TOKEN');
    setEnvValue('GH_TOKEN', 'token-2');
    expect(getGitHubToken()).toBe('token-2');
  });

  it('throws when no token is configured', () => {
    unsetEnvValue('GITHUB_TOKEN');
    unsetEnvValue('GH_TOKEN');
    expect(() => getGitHubToken()).toThrow('Missing GitHub token');
  });

  it('creates an Octokit client when a token is provided', () => {
    const client = createOctokit('token-3');
    expect(client).toBeDefined();
    expect(typeof client.rest).toBe('object');
  });
});
