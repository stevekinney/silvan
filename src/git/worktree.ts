import { join } from 'node:path';

import PQueue from 'p-queue';

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
    const queue = new PQueue({ concurrency: 6 });
    const tasks = worktrees
      .filter((worktree) => !worktree.isLocked)
      .map((worktree) =>
        queue.add(async () => {
          const status = await runGit(['status', '--porcelain'], {
            cwd: worktree.path,
            bus: options.bus,
            context: { ...options.context, worktreePath: worktree.path },
          });
          worktree.isDirty = status.stdout.trim().length > 0;
        }),
      );
    await Promise.all(tasks);
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
  const baseBranch = await resolveBaseBranch({
    repoRoot: options.repoRoot,
    defaultBranch: options.config.repo.defaultBranch,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });

  const result = await runGit(['worktree', 'add', '-b', branch, path, baseBranch], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });

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
          baseBranch,
        },
      }),
    );
  }

  return worktree;
}

async function resolveBaseBranch(options: {
  repoRoot: string;
  defaultBranch: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<string> {
  const localRef = `refs/heads/${options.defaultBranch}`;
  const remoteRef = `refs/remotes/origin/${options.defaultBranch}`;

  if (await hasRef(localRef, options)) {
    return options.defaultBranch;
  }
  if (await hasRef(remoteRef, options)) {
    return `origin/${options.defaultBranch}`;
  }

  await runGit(['fetch', 'origin', options.defaultBranch], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });

  if (await hasRef(remoteRef, options)) {
    return `origin/${options.defaultBranch}`;
  }

  return options.defaultBranch;
}

async function hasRef(
  ref: string,
  options: { repoRoot: string; bus?: EventBus; context: EmitContext },
): Promise<boolean> {
  const result = await runGit(['show-ref', '--verify', '--quiet', ref], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });
  return result.exitCode === 0;
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
