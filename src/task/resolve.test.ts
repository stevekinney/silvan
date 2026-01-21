import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import type { Octokit } from 'octokit';

import type { Config } from '../config/schema';
import { configSchema } from '../config/schema';
import { initStateStore } from '../state/store';
import { createLocalTask } from './providers/local';
import { inferTaskRefFromBranch, parseTaskRef, resolveTask } from './resolve';

const baseConfig = {
  task: { providers: { enabled: ['local', 'linear', 'github'], default: 'local' } },
} as Config;

describe('parseTaskRef', () => {
  it('parses Linear IDs', () => {
    const ref = parseTaskRef('DEP-10', baseConfig);
    expect(ref.provider).toBe('linear');
    expect(ref.id).toBe('DEP-10');
  });

  it('parses gh-123', () => {
    const ref = parseTaskRef('gh-123', baseConfig);
    expect(ref.provider).toBe('github');
    expect(ref.id).toBe('gh-123');
  });

  it('parses GitHub issue URLs', () => {
    const ref = parseTaskRef('https://github.com/acme/repo/issues/42', baseConfig);
    expect(ref.provider).toBe('github');
    expect(ref.owner).toBe('acme');
    expect(ref.repo).toBe('repo');
    expect(ref.number).toBe(42);
  });

  it('parses local task refs', () => {
    const ref = parseTaskRef('local:abc123', baseConfig);
    expect(ref.provider).toBe('local');
    expect(ref.mode).toBe('id');
    expect(ref.id).toBe('abc123');
  });

  it('defaults to local for free-form titles', () => {
    const ref = parseTaskRef('Add offline mode', baseConfig);
    expect(ref.provider).toBe('local');
    expect(ref.mode).toBe('title');
  });

  it('falls back to local when default provider is disabled', () => {
    const ref = parseTaskRef('Add a feature', {
      task: { providers: { enabled: ['local'], default: 'github' } },
    } as Config);
    expect(ref.provider).toBe('local');
  });

  it('throws when github default provider receives an invalid ref', () => {
    expect(() =>
      parseTaskRef('not-a-number', {
        task: { providers: { enabled: ['github'], default: 'github' } },
      } as Config),
    ).toThrow('GitHub task reference must be gh-<number> or an issue URL.');
  });
});

describe('inferTaskRefFromBranch', () => {
  it('prefers GitHub refs from branch names', () => {
    expect(inferTaskRefFromBranch('feature/gh-12-work')).toBe('gh-12');
  });

  it('infers Linear task ids from branches', () => {
    expect(inferTaskRefFromBranch('feature/ENG-42-refactor')).toBe('ENG-42');
  });
});

describe('resolveTask', () => {
  it('creates a local task from a free-form title', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'silvan-resolve-'));
    const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
    const config = configSchema.parse({
      task: { providers: { enabled: ['local'], default: 'local' } },
    });
    const result = await resolveTask('Add docs', {
      config,
      repoRoot,
      state,
      localInput: { title: 'Test', description: 'Test' },
    });
    expect(result.task.provider).toBe('local');
    await state.lockRelease();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('loads an existing local task by id', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'silvan-resolve-'));
    const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
    const config = configSchema.parse({
      task: { providers: { enabled: ['local'], default: 'local' } },
    });
    const created = await createLocalTask({
      state,
      input: { title: 'Existing' },
    });

    const result = await resolveTask(`local:${created.id}`, {
      config,
      repoRoot,
      state,
    });
    expect(result.task.id).toBe(created.id);
    await state.lockRelease();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('resolves GitHub tasks with a stubbed client', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'silvan-resolve-'));
    const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });
    const config = configSchema.parse({
      github: { owner: 'acme', repo: 'repo', token: 'token' },
      task: { providers: { enabled: ['github'], default: 'github' } },
    });
    const octokit = {
      rest: {
        issues: {
          get: async () => ({
            data: {
              number: 12,
              title: 'Issue 12',
              body: 'Body',
              labels: [],
              state: 'open',
            },
          }),
        },
      },
    } as unknown as Octokit;

    const result = await resolveTask('gh-12', {
      config,
      repoRoot,
      state,
      octokit,
    });
    expect(result.task.id).toBe('gh-12');
    await state.lockRelease();
    await rm(repoRoot, { recursive: true, force: true });
  });
});
