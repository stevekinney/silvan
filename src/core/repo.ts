import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export type RepoContext = {
  repoRoot: string;
  projectRoot: string;
  gitRoot: string;
  gitDir: string;
  gitCommonDir: string;
  branch: string;
  isWorktree: boolean;
  worktreePath?: string;
};

async function gitStdout(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return stdout.trim();
}

export async function detectRepoContext(options: { cwd: string }): Promise<RepoContext> {
  const cwd = resolve(options.cwd);
  const gitRoot = await gitStdout(['rev-parse', '--show-toplevel'], cwd);
  const gitDirRaw = await gitStdout(['rev-parse', '--git-dir'], cwd);
  const gitCommonDirRaw = await gitStdout(['rev-parse', '--git-common-dir'], cwd);
  const branch = await gitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const isBare = await gitStdout(['rev-parse', '--is-bare-repository'], cwd);

  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(cwd, gitDirRaw);
  const gitCommonDir = isAbsolute(gitCommonDirRaw)
    ? gitCommonDirRaw
    : resolve(cwd, gitCommonDirRaw);
  const gitDirResolved = await realpath(gitDir).catch(() => gitDir);
  const gitCommonDirResolved = await realpath(gitCommonDir).catch(() => gitCommonDir);
  const gitRootResolved = await realpath(gitRoot).catch(() => gitRoot);
  const isWorktree = isBare !== 'true' && gitDirResolved !== gitCommonDirResolved;
  const worktreePath = isWorktree ? gitRootResolved : undefined;
  const repoRoot = cwd;

  return {
    repoRoot,
    projectRoot: repoRoot,
    gitRoot: gitRootResolved,
    gitDir: gitDirResolved,
    gitCommonDir: gitCommonDirResolved,
    branch,
    isWorktree,
    ...(worktreePath ? { worktreePath } : {}),
  };
}
