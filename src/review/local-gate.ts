import { ProseWriter } from 'prose-writer';

import type { Config } from '../config/schema';
import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { runGit } from '../git/exec';
import type { ArtifactEntry } from '../state/artifacts';
import { readArtifact } from '../state/artifacts';
import type { RunStateData, RunStateEnvelope, StateStore } from '../state/store';

export type Severity = 'blocker' | 'warn' | 'info';

export type GateFinding = {
  id: string;
  severity: Severity;
  title: string;
  details?: string;
  file?: string;
  suggestion?: string;
};

export type LocalGateReport = {
  ok: boolean;
  findings: GateFinding[];
  stats: {
    filesChanged: number;
    linesAdded: number;
    linesDeleted: number;
    hasLockfileChanges: boolean;
    hasDependencyChanges: boolean;
    hasMigrationLikeChanges: boolean;
  };
  generatedAt: string;
};

const dependencyFiles = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

const configFiles = [
  'tsconfig.json',
  'tsconfig.build.json',
  'tsconfig.test.json',
  'eslint.config.js',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.cjs',
  '.eslintrc.js',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.cjs',
  '.prettierrc.js',
  'prettier.config.js',
  'prettier.config.cjs',
];

function parseNumstat(output: string): { added: number; deleted: number; files: number } {
  let added = 0;
  let deleted = 0;
  let files = 0;
  const lines = output.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const [addRaw, delRaw] = line.split('\t');
    const add = addRaw === '-' ? 0 : Number(addRaw);
    const del = delRaw === '-' ? 0 : Number(delRaw);
    if (!Number.isNaN(add) || !Number.isNaN(del)) {
      files += 1;
      added += Number.isNaN(add) ? 0 : add;
      deleted += Number.isNaN(del) ? 0 : del;
    }
  }
  return { added, deleted, files };
}

function diffBaseArgs(baseRef: string): string[] {
  return ['diff', '--numstat', `${baseRef}...HEAD`];
}

function diffNamesArgs(baseRef: string): string[] {
  return ['diff', '--name-only', `${baseRef}...HEAD`];
}

function diffCheckArgs(baseRef: string): string[] {
  return ['diff', '--check', `${baseRef}...HEAD`];
}

function diffHunksArgs(baseRef: string): string[] {
  return ['diff', '-U0', `${baseRef}...HEAD`];
}

async function runDiffWithFallback(
  args: string[],
  options: { repoRoot: string; bus?: EventBus; context: EmitContext },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const primary = await runGit(args, {
    cwd: options.repoRoot,
    context: options.context,
    ...(options.bus ? { bus: options.bus } : {}),
  });
  if (primary.exitCode === 0 && primary.stdout.trim().length > 0) {
    return primary;
  }
  const fallback = await runGit(['diff', ...args.slice(1, -1)], {
    cwd: options.repoRoot,
    context: options.context,
    ...(options.bus ? { bus: options.bus } : {}),
  });
  if (fallback.exitCode === 0 && fallback.stdout.trim().length > 0) {
    return fallback;
  }
  return primary.exitCode === 0 ? primary : fallback;
}

function isSeverity(value: unknown): value is Severity {
  return value === 'blocker' || value === 'warn' || value === 'info';
}

const defaultSeverities: Record<LocalGateRule, Severity> = {
  diffstat: 'warn',
  diffstatLines: 'warn',
  configFiles: 'warn',
  dependencyFiles: 'warn',
  lockfile: 'warn',
  envFile: 'blocker',
  consoleLog: 'warn',
  debugger: 'blocker',
  todo: 'warn',
  diffCheck: 'blocker',
  verifyFailed: 'blocker',
  verifyMissing: 'blocker',
  migration: 'warn',
  branchNaming: 'warn',
};

function buildSeverity(config: Config, key: LocalGateRule): Severity {
  const severities = config.review.localGate.severities;
  const raw =
    severities && typeof severities === 'object'
      ? (severities as Record<string, unknown>)[key]
      : undefined;
  return isSeverity(raw) ? raw : defaultSeverities[key];
}

function classifyDebugLine(
  line: string,
  config: Config,
): Array<{ id: LocalGateRule; title: string }> {
  const results: Array<{ id: LocalGateRule; title: string }> = [];
  const allowList = config.review.localGate.allowConsoleLogPatterns ?? [];
  const allowed = allowList.some((pattern) => {
    try {
      return new RegExp(pattern).test(line);
    } catch {
      return false;
    }
  });

  if (!allowed && /console\.log\s*\(/.test(line)) {
    results.push({ id: 'consoleLog', title: 'Debug console.log added' });
  }
  if (/debugger;?/.test(line)) {
    results.push({ id: 'debugger', title: 'Debugger statement added' });
  }
  if (/\bTODO\b/.test(line) || /\bFIXME\b/.test(line)) {
    results.push({ id: 'todo', title: 'TODO/FIXME added' });
  }
  return results;
}

type LocalGateRule =
  | 'diffstat'
  | 'diffstatLines'
  | 'configFiles'
  | 'dependencyFiles'
  | 'lockfile'
  | 'envFile'
  | 'consoleLog'
  | 'debugger'
  | 'todo'
  | 'diffCheck'
  | 'verifyFailed'
  | 'verifyMissing'
  | 'migration'
  | 'branchNaming';

export async function generateLocalGateReport(options: {
  repoRoot: string;
  baseBranch: string;
  branchName: string;
  worktreePath?: string;
  config: Config;
  state?: StateStore;
  runId?: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<LocalGateReport> {
  const baseRef = options.baseBranch;
  const diffResult = await runDiffWithFallback(diffBaseArgs(baseRef), {
    repoRoot: options.repoRoot,
    context: options.context,
    ...(options.bus ? { bus: options.bus } : {}),
  });
  const numstat = diffResult.exitCode === 0 ? diffResult.stdout : '';
  const stats = parseNumstat(numstat);

  const namesResult = await runDiffWithFallback(diffNamesArgs(baseRef), {
    repoRoot: options.repoRoot,
    context: options.context,
    ...(options.bus ? { bus: options.bus } : {}),
  });
  const fileNames = namesResult.stdout.trim().split('\n').filter(Boolean);
  const statusResult = await runGit(['status', '--porcelain'], {
    cwd: options.repoRoot,
    context: options.context,
    ...(options.bus ? { bus: options.bus } : {}),
  });
  const untracked = statusResult.stdout
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  for (const file of untracked) {
    if (!fileNames.includes(file)) {
      fileNames.push(file);
    }
  }

  const findings: GateFinding[] = [];
  const thresholds = options.config.review.localGate.thresholds;
  if (stats.files > thresholds.filesChangedWarn) {
    findings.push({
      id: 'diffstat',
      severity: buildSeverity(options.config, 'diffstat'),
      title: 'Large number of files changed',
      details: `Files changed: ${stats.files} (threshold ${thresholds.filesChangedWarn})`,
    });
  }
  const totalLines = stats.added + stats.deleted;
  if (totalLines > thresholds.linesChangedWarn) {
    findings.push({
      id: 'diffstatLines',
      severity: buildSeverity(options.config, 'diffstatLines'),
      title: 'Large number of lines changed',
      details: `Lines changed: ${totalLines} (threshold ${thresholds.linesChangedWarn})`,
    });
  }

  const hasLockfileChanges = fileNames.some((file) =>
    /(^|\/)(bun\.lockb|bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(
      file,
    ),
  );
  const hasDependencyChanges = fileNames.some((file) => dependencyFiles.has(file));
  const hasMigrationLikeChanges = fileNames.some(
    (file) => /migrations?\//.test(file) || file.endsWith('.sql'),
  );

  for (const file of fileNames) {
    if (/^\.env(\.|$)/.test(file)) {
      findings.push({
        id: 'envFile',
        severity: buildSeverity(options.config, 'envFile'),
        title: 'Environment file modified',
        file,
        suggestion: 'Avoid committing .env changes.',
      });
    }
    if (configFiles.some((configFile) => file.endsWith(configFile))) {
      findings.push({
        id: 'configFiles',
        severity: buildSeverity(options.config, 'configFiles'),
        title: 'Configuration file modified',
        file,
      });
    }
    if (dependencyFiles.has(file)) {
      findings.push({
        id: 'dependencyFiles',
        severity: buildSeverity(options.config, 'dependencyFiles'),
        title: 'Dependency file modified',
        file,
      });
    }
    if (file.endsWith('bun.lockb') || file.endsWith('bun.lock')) {
      findings.push({
        id: 'lockfile',
        severity: buildSeverity(options.config, 'lockfile'),
        title: 'Lockfile modified',
        file,
      });
    }
    if (/migrations?\//.test(file) || file.endsWith('.sql')) {
      findings.push({
        id: 'migration',
        severity: buildSeverity(options.config, 'migration'),
        title: 'Migration-like changes detected',
        file,
      });
    }
  }

  const diffCheck = await runDiffWithFallback(diffCheckArgs(baseRef), {
    repoRoot: options.repoRoot,
    context: options.context,
    ...(options.bus ? { bus: options.bus } : {}),
  });
  if (diffCheck.stdout.trim().length > 0 || diffCheck.stderr.trim().length > 0) {
    findings.push({
      id: 'diffCheck',
      severity: buildSeverity(options.config, 'diffCheck'),
      title: 'Whitespace or patch formatting issues detected',
      details: diffCheck.stdout.trim() || diffCheck.stderr.trim(),
    });
  }

  const hunkResult = await runDiffWithFallback(diffHunksArgs(baseRef), {
    repoRoot: options.repoRoot,
    context: options.context,
    ...(options.bus ? { bus: options.bus } : {}),
  });
  const hunkLines = hunkResult.stdout.split('\n');
  for (const line of hunkLines) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const matches = classifyDebugLine(line, options.config);
    for (const match of matches) {
      findings.push({
        id: match.id,
        severity: buildSeverity(options.config, match.id),
        title: match.title,
        details: line.slice(1).trim(),
      });
    }
  }

  if (options.config.review.localGate.requireVerifyBeforePr) {
    const verifySummary = await resolveVerifySummary(options.state, options.runId);
    if (!verifySummary) {
      findings.push({
        id: 'verifyMissing',
        severity: buildSeverity(options.config, 'verifyMissing'),
        title: 'Verification has not run yet',
      });
    } else if (!verifySummary.ok) {
      findings.push({
        id: 'verifyFailed',
        severity: buildSeverity(options.config, 'verifyFailed'),
        title: 'Verification failed',
      });
    }
  }

  if (options.config.naming.branchPrefix) {
    if (!options.branchName.startsWith(options.config.naming.branchPrefix)) {
      findings.push({
        id: 'branchNaming',
        severity: buildSeverity(options.config, 'branchNaming'),
        title: 'Branch name does not match configured prefix',
        details: `Expected prefix: ${options.config.naming.branchPrefix}`,
      });
    }
  }

  const ok = !findings.some((finding) => finding.severity === 'blocker');
  return {
    ok,
    findings,
    stats: {
      filesChanged: stats.files,
      linesAdded: stats.added,
      linesDeleted: stats.deleted,
      hasLockfileChanges,
      hasDependencyChanges,
      hasMigrationLikeChanges,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function resolveVerifySummary(
  state: StateStore | undefined,
  runId: string | undefined,
): Promise<{ ok: boolean } | undefined> {
  if (!state || !runId) return undefined;
  const runState: RunStateEnvelope | null = await state.readRunState(runId);
  const data: RunStateData = runState?.data ?? {};
  const summaryValue = data['verifySummary'];
  if (
    summaryValue &&
    typeof summaryValue === 'object' &&
    'ok' in summaryValue &&
    typeof (summaryValue as { ok?: unknown }).ok === 'boolean'
  ) {
    return { ok: (summaryValue as { ok: boolean }).ok };
  }
  const index = data['artifactsIndex'] as
    | Record<string, Record<string, ArtifactEntry>>
    | undefined;
  const entry = index?.['verify.run']?.['report'];
  if (!entry || entry.kind !== 'json') return undefined;
  const report = await readArtifact<{ ok?: boolean }>({ entry });
  if (typeof report?.ok === 'boolean') {
    return { ok: report.ok };
  }
  return undefined;
}

export function formatLocalGateSummary(report: LocalGateReport): string {
  const writer = new ProseWriter();
  const blockers = report.findings.filter(
    (finding) => finding.severity === 'blocker',
  ).length;
  const warnings = report.findings.filter(
    (finding) => finding.severity === 'warn',
  ).length;
  writer.write(`Local gate: ${report.ok ? 'ok' : 'blocked'}`);
  writer.write(`Blockers: ${blockers}`);
  writer.write(`Warnings: ${warnings}`);
  return writer.toString().trimEnd();
}
