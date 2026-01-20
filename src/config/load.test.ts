import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { readEnvValue, setEnvValue, unsetEnvValue } from '../utils/env';
import { loadConfig } from './load';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-config-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    await fn(dir);
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
}

async function runGit(args: string[], cwd: string): Promise<void> {
  const env = { ...process.env };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  delete env['GIT_INDEX_FILE'];
  const proc = Bun.spawn(['git', ...args], { cwd, env });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`);
  }
}

async function withTempRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'silvan-repo-'));
  try {
    await runGit(['init', '-b', 'main'], dir);
    await runGit(['config', 'user.name', 'Test'], dir);
    await runGit(['config', 'user.email', 'test@example.com'], dir);
    await writeFile(join(dir, 'README.md'), '# Test');
    await runGit(['add', 'README.md'], dir);
    await runGit(['commit', '-m', 'init'], dir);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withQuietEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env['SILVAN_QUIET'];
  try {
    process.env['SILVAN_QUIET'] = '1';
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env['SILVAN_QUIET'];
    } else {
      process.env['SILVAN_QUIET'] = previous;
    }
  }
}

describe('loadConfig', () => {
  test('loads a TypeScript config', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'silvan.config.ts');
      await writeFile(path, `export default { naming: { worktreeDir: '.custom' } };`);
      const result = await loadConfig();
      expect(result.config.naming.worktreeDir).toBe('.custom');
    });
  });

  test('loads a JSON config', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'silvan.config.json');
      await writeFile(path, JSON.stringify({ naming: { worktreeDir: '.json' } }));
      const result = await loadConfig();
      expect(result.config.naming.worktreeDir).toBe('.json');
    });
  });

  test('rejects invalid config', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'silvan.config.json');
      await writeFile(
        path,
        JSON.stringify({ verify: { commands: [{ name: '', cmd: '' }] } }),
      );
      return expect(loadConfig()).rejects.toThrow('Invalid config');
    });
  });

  test('loads .env before reading environment overrides', async () => {
    await withTempDir(async (dir) => {
      const previous = Bun.env['GITHUB_TOKEN'];
      try {
        Bun.env['GITHUB_TOKEN'] = 'shell_token';
        await writeFile(join(dir, '.env'), 'GITHUB_TOKEN=env_token');
        await writeFile(join(dir, 'silvan.config.json'), JSON.stringify({}));
        const result = await loadConfig();
        expect(result.config.github.token).toBe('env_token');
      } finally {
        if (previous === undefined) {
          delete Bun.env['GITHUB_TOKEN'];
        } else {
          Bun.env['GITHUB_TOKEN'] = previous;
        }
      }
    });
  });

  test('uses the nearest config as the project root', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'silvan.config.json'), JSON.stringify({}));
      const nested = join(dir, 'apps', 'web');
      await mkdir(nested, { recursive: true });
      const result = await loadConfig(undefined, { cwd: nested });
      expect(result.projectRoot).toBe(dir);
    });
  });

  test('uses git root as the project root when no config is present', async () => {
    await withTempRepo(async (repoRoot) => {
      const nested = join(repoRoot, 'apps', 'web');
      await mkdir(nested, { recursive: true });
      const result = await withQuietEnv(() => loadConfig(undefined, { cwd: nested }));
      expect(result.projectRoot).toBe(await realpath(repoRoot));
    });
  });

  test('infers worktree directory from repo defaults', async () => {
    await withTempRepo(async (repoRoot) => {
      await mkdir(join(repoRoot, 'worktrees'), { recursive: true });
      const result = await withQuietEnv(() => loadConfig(undefined, { cwd: repoRoot }));
      expect(result.config.naming.worktreeDir).toBe('worktrees');
    });
  });

  test('infers branch prefix from existing branches', async () => {
    await withTempRepo(async (repoRoot) => {
      await runGit(['branch', 'dep/dep-10'], repoRoot);
      await runGit(['branch', 'dep/dep-11'], repoRoot);
      const result = await withQuietEnv(() => loadConfig(undefined, { cwd: repoRoot }));
      expect(result.config.naming.branchPrefix).toBe('dep/');
    });
  });

  test('enables providers from env tokens when not explicitly configured', async () => {
    await withTempRepo(async (repoRoot) => {
      const previousGitHub = readEnvValue('GITHUB_TOKEN');
      const previousLinear = readEnvValue('LINEAR_API_KEY');
      try {
        setEnvValue('GITHUB_TOKEN', 'gh-token');
        setEnvValue('LINEAR_API_KEY', 'linear-token');
        const result = await withQuietEnv(() => loadConfig(undefined, { cwd: repoRoot }));
        expect(result.config.task.providers.enabled).toEqual([
          'local',
          'github',
          'linear',
        ]);
        expect(result.config.task.providers.default).toBe('github');
      } finally {
        if (previousGitHub === undefined) {
          unsetEnvValue('GITHUB_TOKEN');
        } else {
          setEnvValue('GITHUB_TOKEN', previousGitHub);
        }
        if (previousLinear === undefined) {
          unsetEnvValue('LINEAR_API_KEY');
        } else {
          setEnvValue('LINEAR_API_KEY', previousLinear);
        }
      }
    });
  });

  test('uses worktrees.toml defaults when no config is present', async () => {
    await withTempRepo(async (repoRoot) => {
      const contents = [
        'worktreeDir = "worktrees"',
        'githubOwner = "lasercat-industries"',
        'githubRepo = "depict"',
        'defaultBranch = "main"',
        'linearTeamKey = "DEP"',
      ].join('\n');
      await writeFile(join(repoRoot, 'worktrees.toml'), contents);
      const result = await withQuietEnv(() => loadConfig(undefined, { cwd: repoRoot }));
      expect(result.config.naming.worktreeDir).toBe('worktrees');
      expect(result.config.github.owner).toBe('lasercat-industries');
      expect(result.config.github.repo).toBe('depict');
      expect(result.config.repo.defaultBranch).toBe('main');
    });
  });
});
