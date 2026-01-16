import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import PQueue from 'p-queue';
import { ProseWriter } from 'prose-writer';

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
  const existing = await findWorktreeByPath({
    repoRoot: options.repoRoot,
    path,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });
  if (existing) {
    return existing;
  }

  await ensureParentDir(path);

  const baseBranch = options.config.repo.defaultBranch;
  await fetchBranch({
    repoRoot: options.repoRoot,
    branch: baseBranch,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });
  await fetchBranch({
    repoRoot: options.repoRoot,
    branch,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });

  const baseRef = await resolveBaseRef({
    repoRoot: options.repoRoot,
    baseBranch,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });

  const hasLocalBranch = await hasRef(`refs/heads/${branch}`, {
    repoRoot: options.repoRoot,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });
  const hasRemoteBranch = await hasRef(`refs/remotes/origin/${branch}`, {
    repoRoot: options.repoRoot,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });

  let args: string[];
  if (hasLocalBranch) {
    args = ['worktree', 'add', path, branch];
  } else if (hasRemoteBranch) {
    args = ['worktree', 'add', '-b', branch, path, `origin/${branch}`];
  } else {
    args = ['worktree', 'add', '-b', branch, path, baseRef];
  }

  const result = await runGit(args, {
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

async function resolveBaseRef(options: {
  repoRoot: string;
  baseBranch: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<string> {
  const localRef = `refs/heads/${options.baseBranch}`;
  const remoteRef = `refs/remotes/origin/${options.baseBranch}`;

  if (await hasRef(localRef, options)) {
    return options.baseBranch;
  }
  if (await hasRef(remoteRef, options)) {
    return `origin/${options.baseBranch}`;
  }

  await runGit(['fetch', 'origin', options.baseBranch], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });

  if (await hasRef(remoteRef, options)) {
    return `origin/${options.baseBranch}`;
  }

  return options.baseBranch;
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

async function fetchBranch(options: {
  repoRoot: string;
  branch: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<void> {
  const result = await runGit(['fetch', 'origin', options.branch], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });
  if (result.exitCode !== 0) {
    return;
  }
}

async function ensureParentDir(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
}

async function findWorktreeByPath(options: {
  repoRoot: string;
  path: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<WorktreeInfo | null> {
  const worktrees = await listWorktrees({
    repoRoot: options.repoRoot,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });
  const resolved = resolve(options.path);
  return worktrees.find((worktree) => resolve(worktree.path) === resolved) ?? null;
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

export async function pruneWorktrees(options: {
  repoRoot: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<void> {
  const result = await runGit(['worktree', 'prune'], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to prune worktrees');
  }
}

export async function lockWorktree(options: {
  repoRoot: string;
  path: string;
  reason?: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<void> {
  const args = ['worktree', 'lock'];
  if (options.reason) {
    args.push('--reason', options.reason);
  }
  args.push(options.path);

  const result = await runGit(args, {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to lock worktree');
  }
}

export async function unlockWorktree(options: {
  repoRoot: string;
  path: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<void> {
  const result = await runGit(['worktree', 'unlock', options.path], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to unlock worktree');
  }
}

export async function rebaseOntoBase(options: {
  repoRoot: string;
  baseBranch: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<boolean> {
  await fetchBranch({
    repoRoot: options.repoRoot,
    branch: options.baseBranch,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });

  const baseRef = await resolveBaseRef({
    repoRoot: options.repoRoot,
    baseBranch: options.baseBranch,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
  });

  const result = await runGit(['rebase', baseRef], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });

  if (result.exitCode === 0) {
    return true;
  }

  await runGit(['rebase', '--abort'], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });
  return false;
}

export async function hasUncommittedChanges(options: {
  worktreePath: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<boolean> {
  const status = await getStatus(options);
  return status.isDirty;
}

export async function installDependencies(options: {
  worktreePath: string;
}): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', 'install'], { cwd: options.worktreePath });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return {
    ok: exitCode === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

export async function normalizeClaudeSettings(options: {
  worktreePath: string;
}): Promise<void> {
  const settingsPath = join(options.worktreePath, '.claude', 'settings.json');
  const settingsFile = Bun.file(settingsPath);
  if (!(await settingsFile.exists())) {
    return;
  }

  try {
    const raw = await readFile(settingsPath, 'utf8');
    const settings = JSON.parse(raw) as {
      permissions?: { allow?: string[]; deny?: string[] };
    };
    const allow = settings.permissions?.allow;
    if (allow && allow.includes('Bash(*)')) {
      settings.permissions = settings.permissions ?? {};
      const nextAllow = allow.filter((entry) => entry !== 'Bash(*)');
      if (!nextAllow.includes('Bash')) {
        nextAllow.unshift('Bash');
      }
      settings.permissions.allow = nextAllow;
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
  } catch {
    return;
  }
}

export async function ensureArtifactsIgnored(options: {
  worktreePath: string;
  entries?: string[];
  bus?: EventBus;
  context: EmitContext;
}): Promise<void> {
  const entries = options.entries ?? ['.claude-artifacts.json', '.worktree-run.json'];
  const gitignorePath = join(options.worktreePath, '.gitignore');
  const gitignoreFile = Bun.file(gitignorePath);
  const exists = await gitignoreFile.exists();
  const current = exists ? await readFile(gitignorePath, 'utf8') : '';
  const lines = current.split('\n').map((line) => line.trim());
  const missing = entries.filter((entry) => !lines.includes(entry));

  if (missing.length > 0) {
    const suffix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    const writer = new ProseWriter();
    const missingBlock = missing.reduce(
      (acc, entry, index) => `${acc}${index ? '\n' : ''}${entry}`,
      '',
    );
    writer.write(missingBlock);
    const updated = `${current}${suffix}${writer.toString().trimEnd()}\n`;
    await writeFile(gitignorePath, updated);
  }

  for (const entry of entries) {
    const tracked = await runGit(['ls-files', '--error-unmatch', entry], {
      cwd: options.worktreePath,
      bus: options.bus,
      context: { ...options.context, worktreePath: options.worktreePath },
    });

    if (tracked.exitCode === 0) {
      await runGit(['rm', '--cached', '-f', entry], {
        cwd: options.worktreePath,
        bus: options.bus,
        context: { ...options.context, worktreePath: options.worktreePath },
      });
    }
  }
}
