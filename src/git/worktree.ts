import { join } from 'node:path';

import type { Config } from '../config/schema';
import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { hashString } from '../utils/hash';
import { runGit } from './exec';

export type WorktreeInfo = {
  id: string;
  path: string;
  branch?: string;
  headSha?: string;
  isBare?: boolean;
  isLocked?: boolean;
  isDirty?: boolean;
};

function parseWorktreeList(output: string): WorktreeInfo[] {
  const entries: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split('\n')) {
    if (!line.trim()) {
      if (current.path) {
        const path = current.path;
        entries.push({ id: hashString(path), ...current } as WorktreeInfo);
      }
      current = {};
      continue;
    }

    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');

    switch (key) {
      case 'worktree':
        current.path = value;
        break;
      case 'branch':
        current.branch = value.replace('refs/heads/', '');
        break;
      case 'HEAD':
        current.headSha = value;
        break;
      case 'locked':
        current.isLocked = true;
        break;
      case 'bare':
        current.isBare = true;
        break;
      default:
        break;
    }
  }

  if (current.path) {
    const path = current.path;
    entries.push({ id: hashString(path), ...current } as WorktreeInfo);
  }

  return entries;
}

export async function listWorktrees(options: {
  repoRoot: string;
  bus?: EventBus;
  context: EmitContext;
  includeStatus?: boolean;
}): Promise<WorktreeInfo[]> {
  const result = await runGit(['worktree', 'list', '--porcelain'], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to list worktrees');
  }

  const worktrees = parseWorktreeList(result.stdout.trim());

  if (options.includeStatus) {
    await Promise.all(
      worktrees.map(async (worktree) => {
        const status = await runGit(['status', '--porcelain'], {
          cwd: worktree.path,
          bus: options.bus,
          context: { ...options.context, worktreePath: worktree.path },
        });
        worktree.isDirty = status.stdout.trim().length > 0;
      }),
    );
  }

  if (options.bus) {
    await options.bus.emit(
      createEnvelope({
        type: 'worktree.listed',
        source: 'git',
        level: 'info',
        context: options.context,
        payload: {
          count: worktrees.length,
          worktrees,
        },
      }),
    );
  }

  return worktrees;
}

export async function createWorktree(options: {
  repoRoot: string;
  name: string;
  config: Config;
  bus?: EventBus;
  context: EmitContext;
}): Promise<WorktreeInfo> {
  const dir = options.config.naming.worktreeDir;
  const branch = `${options.config.naming.branchPrefix}${options.name}`;
  const path = join(options.repoRoot, dir, options.name);

  const result = await runGit(
    ['worktree', 'add', '-b', branch, path, options.config.repo.defaultBranch],
    {
      cwd: options.repoRoot,
      bus: options.bus,
      context: options.context,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to create worktree');
  }

  const worktree = {
    id: hashString(path),
    path,
    branch,
  } satisfies WorktreeInfo;

  if (options.bus) {
    await options.bus.emit(
      createEnvelope({
        type: 'worktree.created',
        source: 'git',
        level: 'info',
        context: { ...options.context, worktreePath: path },
        payload: {
          id: worktree.id,
          path,
          branch,
          baseBranch: options.config.repo.defaultBranch,
        },
      }),
    );
  }

  return worktree;
}

export async function removeWorktree(options: {
  repoRoot: string;
  path: string;
  force?: boolean;
  bus?: EventBus;
  context: EmitContext;
}): Promise<void> {
  const args = ['worktree', 'remove'];
  if (options.force) {
    args.push('--force');
  }
  args.push(options.path);

  const result = await runGit(args, {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to remove worktree');
  }

  if (options.bus) {
    await options.bus.emit(
      createEnvelope({
        type: 'worktree.removed',
        source: 'git',
        level: 'info',
        context: { ...options.context, worktreePath: options.path },
        payload: {
          id: hashString(options.path),
          path: options.path,
          forced: Boolean(options.force),
        },
      }),
    );
  }
}

export async function getStatus(options: {
  worktreePath: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<{ isDirty: boolean; porcelain: string }> {
  const result = await runGit(['status', '--porcelain'], {
    cwd: options.worktreePath,
    bus: options.bus,
    context: { ...options.context, worktreePath: options.worktreePath },
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to get git status');
  }

  const porcelain = result.stdout.trim();
  const isDirty = porcelain.length > 0;

  if (options.bus) {
    await options.bus.emit(
      createEnvelope({
        type: 'git.status',
        source: 'git',
        level: 'info',
        context: { ...options.context, worktreePath: options.worktreePath },
        payload: {
          path: options.worktreePath,
          branch: '',
          isDirty,
          porcelain,
        },
      }),
    );
  }

  return { isDirty, porcelain };
}
