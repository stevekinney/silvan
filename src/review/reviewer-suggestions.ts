import { access, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { runGit } from '../git/exec';
import type { ReviewerStats } from '../state/reviewers';

export type ReviewerSuggestion = {
  users: string[];
  teams: string[];
  sources: {
    codeowners: string[];
    blame: string[];
  };
  changedFiles: string[];
};

type CodeownersEntry = {
  pattern: string;
  owners: string[];
  source: string;
};

const CODEOWNERS_PATHS = [
  join('.github', 'CODEOWNERS'),
  join('docs', 'CODEOWNERS'),
  'CODEOWNERS',
];

export async function suggestReviewers(options: {
  repoRoot: string;
  baseBranch: string;
  headBranch: string;
  reviewerAliases: Record<string, string>;
  useCodeowners: boolean;
  useBlame: boolean;
  maxSuggestions: number;
  reviewerStats?: ReviewerStats;
}): Promise<ReviewerSuggestion> {
  const changedFiles = await listChangedFiles(options);
  const codeownerCounts = options.useCodeowners
    ? await collectCodeowners(options.repoRoot, changedFiles)
    : new Map<string, number>();
  const blameCounts = options.useBlame
    ? await collectBlameOwners(options.repoRoot, changedFiles, options.reviewerAliases)
    : new Map<string, number>();

  const users = new Set<string>();
  const teams = new Set<string>();
  for (const [owner] of codeownerCounts) {
    const normalized = normalizeOwner(owner);
    if (!normalized) continue;
    if (normalized.includes('/')) {
      teams.add(normalized);
    } else {
      users.add(normalized);
    }
  }
  for (const [owner] of blameCounts) {
    const normalized = normalizeOwner(owner);
    if (!normalized || normalized.includes('/')) continue;
    users.add(normalized);
  }

  const scoredUsers = scoreReviewers({
    candidates: Array.from(users),
    codeowners: codeownerCounts,
    blame: blameCounts,
    ...(options.reviewerStats ? { reviewerStats: options.reviewerStats } : {}),
  });

  return {
    users: scoredUsers.slice(0, options.maxSuggestions),
    teams: Array.from(teams),
    sources: {
      codeowners: Array.from(codeownerCounts.keys()),
      blame: Array.from(blameCounts.keys()),
    },
    changedFiles,
  };
}

async function listChangedFiles(options: {
  repoRoot: string;
  baseBranch: string;
  headBranch: string;
}): Promise<string[]> {
  const diff = await runGit(
    ['diff', '--name-only', `${options.baseBranch}...${options.headBranch}`],
    {
      cwd: options.repoRoot,
      context: { runId: 'review', repoRoot: options.repoRoot, mode: 'headless' },
    },
  );
  if (diff.exitCode !== 0) {
    return [];
  }
  return diff.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => posix.normalize(line));
}

async function collectCodeowners(
  repoRoot: string,
  changedFiles: string[],
): Promise<Map<string, number>> {
  const entries = await loadCodeowners(repoRoot);
  if (entries.length === 0 || changedFiles.length === 0) {
    return new Map<string, number>();
  }
  const counts = new Map<string, number>();
  for (const file of changedFiles) {
    const owners = matchCodeowners(entries, file);
    for (const owner of owners) {
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
  }
  return counts;
}

async function loadCodeowners(repoRoot: string): Promise<CodeownersEntry[]> {
  for (const candidate of CODEOWNERS_PATHS) {
    const path = join(repoRoot, candidate);
    try {
      await access(path);
    } catch {
      continue;
    }
    const raw = await readFile(path, 'utf8');
    return parseCodeowners(raw, candidate);
  }
  return [];
}

function parseCodeowners(content: string, source: string): CodeownersEntry[] {
  const entries: CodeownersEntry[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    const pattern = parts.shift();
    if (!pattern || parts.length === 0) continue;
    entries.push({ pattern, owners: parts, source });
  }
  return entries;
}

function matchCodeowners(entries: CodeownersEntry[], filePath: string): string[] {
  let matched: CodeownersEntry | undefined;
  for (const entry of entries) {
    if (matchesPattern(entry.pattern, filePath)) {
      matched = entry;
    }
  }
  return matched ? matched.owners : [];
}

function matchesPattern(pattern: string, filePath: string): boolean {
  const normalized = posix.normalize(filePath);
  const anchored = pattern.startsWith('/');
  const cleaned = pattern.replace(/^\/+/, '');
  const normalizedPattern = cleaned.endsWith('/') ? `${cleaned}**` : cleaned;
  const regex = patternToRegex(normalizedPattern, anchored);
  return regex.test(normalized);
}

function patternToRegex(pattern: string, anchored: boolean): RegExp {
  let source = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern.charAt(i);
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 2;
      } else {
        source += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }
    source += escapeRegex(char);
    i += 1;
  }
  const prefix = anchored ? '^' : '(^|.*/)';
  return new RegExp(`${prefix}${source}$`);
}

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function collectBlameOwners(
  repoRoot: string,
  changedFiles: string[],
  aliases: Record<string, string>,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const file of changedFiles) {
    const result = await runGit(['blame', '--line-porcelain', '--', file], {
      cwd: repoRoot,
      context: { runId: 'review', repoRoot, mode: 'headless' },
    });
    if (result.exitCode !== 0) continue;
    const lines = result.stdout.split('\n');
    for (const line of lines) {
      if (!line.startsWith('author-mail ')) continue;
      const raw = line.slice('author-mail '.length).trim();
      const email = raw.replace(/[<>]/g, '');
      const handle = inferReviewerHandle(email, aliases);
      if (!handle) continue;
      counts.set(handle, (counts.get(handle) ?? 0) + 1);
    }
  }
  return counts;
}

function inferReviewerHandle(
  email: string,
  aliases: Record<string, string>,
): string | null {
  if (aliases[email]) return aliases[email];
  const local = email.split('@')[0] ?? '';
  if (aliases[local]) return aliases[local];
  if (/^[a-zA-Z0-9-]+$/.test(local)) return local;
  return null;
}

function normalizeOwner(owner: string): string | null {
  const trimmed = owner.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

function scoreReviewers(options: {
  candidates: string[];
  codeowners: Map<string, number>;
  blame: Map<string, number>;
  reviewerStats?: ReviewerStats;
}): string[] {
  const scores = new Map<string, number>();
  for (const reviewer of options.candidates) {
    const codeownerScore = options.codeowners.get(reviewer) ?? 0;
    const blameScore = options.blame.get(reviewer) ?? 0;
    const stats = options.reviewerStats?.reviewers[reviewer];
    const responseScore =
      stats?.avgResponseHours && stats.avgResponseHours > 0
        ? 1 / stats.avgResponseHours
        : 0;
    scores.set(reviewer, codeownerScore * 2 + blameScore + responseScore);
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reviewer]) => reviewer);
}

export const __test = {
  parseCodeowners,
  matchesPattern,
  scoreReviewers,
  inferReviewerHandle,
};
