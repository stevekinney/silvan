import { resolve } from 'node:path';

export type RepoContext = {
  repoRoot: string;
  gitDir: string;
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
  const repoRoot = await gitStdout(['rev-parse', '--show-toplevel'], cwd);
  const gitDir = await gitStdout(['rev-parse', '--git-dir'], cwd);
  const branch = await gitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const isBare = await gitStdout(['rev-parse', '--is-bare-repository'], cwd);

  const isWorktree = isBare !== 'true' && repoRoot !== cwd;
  const worktreePath = isWorktree ? cwd : undefined;

  return {
    repoRoot,
    gitDir,
    branch,
    isWorktree,
    ...(worktreePath ? { worktreePath } : {}),
  };
}
