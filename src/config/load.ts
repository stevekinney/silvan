import { access, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { cosmiconfig } from 'cosmiconfig';
import { ProseWriter } from 'prose-writer';

import { formatKeyValues, renderNextSteps, renderSectionHeader } from '../cli/output';
import { SilvanError } from '../core/errors';
import { readEnvValue } from '../utils/env';
import { loadProjectEnv } from './env';
import type { Config, ConfigInput } from './schema';
import { configSchema } from './schema';
import { parseGitHubRemote } from './validate';

export type ConfigResult = {
  config: Config;
  source: { path: string; format: string } | null;
  projectRoot: string;
};

async function loadTsConfig(path: string): Promise<unknown> {
  const module = (await import(pathToFileURL(path).toString())) as {
    default?: unknown;
    config?: unknown;
  };
  return module.default ?? module.config ?? module;
}

type EnvValue = string | undefined;

function parseNumber(value: EnvValue): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBool(value: EnvValue): boolean | undefined {
  if (!value) return undefined;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return undefined;
}

function mergeConfig(base: Config, override?: ConfigInput): Config {
  if (!override) return base;
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      output[key] = value;
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      const baseValue = output[key];
      if (
        typeof baseValue === 'object' &&
        baseValue !== null &&
        !Array.isArray(baseValue)
      ) {
        output[key] = mergeConfig(baseValue as Config, value as ConfigInput);
      } else {
        output[key] = value;
      }
      continue;
    }
    output[key] = value;
  }
  return output as Config;
}

const CONFIG_FILES = [
  'silvan.config.ts',
  'silvan.config.js',
  'silvan.config.json',
  'silvan.config.yaml',
  'silvan.config.yml',
];

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findConfigPath(searchFrom: string): Promise<string | null> {
  let current = searchFrom;
  while (true) {
    for (const candidate of CONFIG_FILES) {
      const path = join(current, candidate);
      if (await pathExists(path)) {
        return path;
      }
    }

    const packagePath = join(current, 'package.json');
    if (await pathExists(packagePath)) {
      try {
        const raw = await readFile(packagePath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && 'silvan' in parsed) {
          return packagePath;
        }
      } catch {
        // ignore invalid package.json
      }
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

type TaskProvider = 'local' | 'github' | 'linear';

type WorktreesToml = {
  worktreeDir?: string;
  githubOwner?: string;
  githubRepo?: string;
  defaultBranch?: string;
  linearTeamKey?: string;
};

const PROVIDER_ORDER: TaskProvider[] = ['local', 'github', 'linear'];

let missingConfigNoticeShown = false;

function shouldShowMissingConfigNotice(): boolean {
  if (missingConfigNoticeShown) return false;
  if (!process.stdout.isTTY) return false;
  if (process.env['SILVAN_JSON']) return false;
  if (process.env['SILVAN_QUIET']) return false;
  missingConfigNoticeShown = true;
  return true;
}

function renderMissingConfigNotice(config: Config, projectRoot: string): string {
  const details: Array<[string, string]> = [
    ['Project root', projectRoot],
    ['Worktree dir', config.naming.worktreeDir],
    ['Branch prefix', config.naming.branchPrefix],
    ['Default branch', config.repo.defaultBranch],
    ['Providers', config.task.providers.enabled.join(', ')],
  ];
  if (config.github.owner && config.github.repo) {
    details.push(['GitHub', `github.com/${config.github.owner}/${config.github.repo}`]);
  }
  return [
    renderSectionHeader('Detected defaults', { width: 60, kind: 'minor' }),
    ...formatKeyValues(details, { labelWidth: 16 }),
    renderNextSteps(['silvan init']),
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNestedKey(value: unknown, path: string[]): boolean {
  if (!isRecord(value)) return false;
  let current: Record<string, unknown> = value;
  for (const key of path) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      return false;
    }
    const next = current[key];
    if (!isRecord(next) && key !== path[path.length - 1]) {
      return false;
    }
    current = next as Record<string, unknown>;
  }
  return true;
}

async function gitStdout(args: string[], cwd: string): Promise<string | null> {
  const env = { ...process.env };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  delete env['GIT_INDEX_FILE'];
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function resolveGitRoot(cwd: string): Promise<string | null> {
  const root = await gitStdout(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return null;
  return (await realpath(root).catch(() => root)) ?? root;
}

async function detectDefaultBranch(repoRoot: string): Promise<string | null> {
  const headRef = await gitStdout(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot);
  if (!headRef) return null;
  const parts = headRef.split('/');
  return parts[parts.length - 1] || null;
}

async function detectGitHubRepo(
  repoRoot: string,
): Promise<{ owner: string; repo: string } | null> {
  const remote = await gitStdout(['remote', 'get-url', 'origin'], repoRoot);
  if (!remote) return null;
  return parseGitHubRemote(remote);
}

async function loadWorktreesToml(repoRoot: string): Promise<WorktreesToml | null> {
  const path = join(repoRoot, 'worktrees.toml');
  if (!(await pathExists(path))) return null;
  if (!Bun.TOML?.parse) return null;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
    if (!isRecord(parsed)) return null;
    const output: WorktreesToml = {};
    const worktreeDir = parsed['worktreeDir'];
    if (typeof worktreeDir === 'string') {
      output.worktreeDir = worktreeDir;
    }
    const githubOwner = parsed['githubOwner'];
    if (typeof githubOwner === 'string') {
      output.githubOwner = githubOwner;
    }
    const githubRepo = parsed['githubRepo'];
    if (typeof githubRepo === 'string') {
      output.githubRepo = githubRepo;
    }
    const defaultBranch = parsed['defaultBranch'];
    if (typeof defaultBranch === 'string') {
      output.defaultBranch = defaultBranch;
    }
    const linearTeamKey = parsed['linearTeamKey'];
    if (typeof linearTeamKey === 'string') {
      output.linearTeamKey = linearTeamKey;
    }
    return Object.keys(output).length > 0 ? output : null;
  } catch {
    return null;
  }
}

function normalizeProviders(values: TaskProvider[]): TaskProvider[] {
  const unique = new Set<TaskProvider>(values);
  if (unique.size === 0) {
    unique.add('local');
  }
  return PROVIDER_ORDER.filter((provider) => unique.has(provider));
}

async function detectWorktreeDirFromGit(repoRoot: string): Promise<string | null> {
  const output = await gitStdout(['worktree', 'list', '--porcelain'], repoRoot);
  if (!output) return null;
  const counts = new Map<string, number>();
  for (const line of output.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const path = line.slice('worktree '.length).trim();
    if (!path) continue;
    const rel = relative(repoRoot, path);
    if (!rel || rel.startsWith('..')) continue;
    const segment = rel.split(/[/\\]/)[0];
    if (!segment) continue;
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const [best] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return best ? best[0] : null;
}

async function detectWorktreeDir(repoRoot: string): Promise<string> {
  const fromGit = await detectWorktreeDirFromGit(repoRoot);
  if (fromGit) return fromGit;
  const candidates = ['.worktrees', 'worktrees', '.trees'];
  for (const dir of candidates) {
    const path = join(repoRoot, dir);
    try {
      await readdir(path);
      return dir;
    } catch {
      // Directory doesn't exist, continue.
    }
  }
  return '.worktrees';
}

async function detectBranchPrefix(
  repoRoot: string,
  defaultBranch: string,
): Promise<string | null> {
  const counts = new Map<string, number>();
  const worktreeOutput = await gitStdout(['worktree', 'list', '--porcelain'], repoRoot);
  const branches: string[] = [];
  if (worktreeOutput) {
    for (const line of worktreeOutput.split('\n')) {
      if (!line.startsWith('branch ')) continue;
      const raw = line.slice('branch '.length).trim();
      const branch = raw.replace('refs/heads/', '');
      if (branch && branch !== defaultBranch && branch !== '(detached)') {
        branches.push(branch);
      }
    }
  }
  if (branches.length === 0) {
    const branchOutput = await gitStdout(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      repoRoot,
    );
    if (branchOutput) {
      branches.push(
        ...branchOutput
          .split('\n')
          .map((line) => line.trim())
          .filter((branch) => branch && branch !== defaultBranch),
      );
    }
  }
  for (const branch of branches) {
    const slashIndex = branch.indexOf('/');
    if (slashIndex <= 0) continue;
    const prefix = branch.slice(0, slashIndex + 1);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const [best] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (!best) return null;
  const [prefix, count] = best;
  return count >= 2 ? prefix : null;
}

async function inferConfigDefaults(options: {
  repoRoot: string;
  baseConfig: unknown;
  worktreesToml: WorktreesToml | null;
}): Promise<ConfigInput> {
  const output: ConfigInput = {};
  const baseConfig = options.baseConfig;
  const hasWorktreeDir = hasNestedKey(baseConfig, ['naming', 'worktreeDir']);
  const hasBranchPrefix = hasNestedKey(baseConfig, ['naming', 'branchPrefix']);
  const hasDefaultBranch = hasNestedKey(baseConfig, ['repo', 'defaultBranch']);
  const hasProviders = hasNestedKey(baseConfig, ['task', 'providers']);
  const hasGitHubOwner = hasNestedKey(baseConfig, ['github', 'owner']);
  const hasGitHubRepo = hasNestedKey(baseConfig, ['github', 'repo']);

  const worktreesToml = options.worktreesToml;
  const defaultBranch =
    worktreesToml?.defaultBranch ??
    (hasDefaultBranch ? undefined : await detectDefaultBranch(options.repoRoot)) ??
    undefined;
  if (!hasDefaultBranch && defaultBranch) {
    output.repo = { ...(output.repo ?? {}), defaultBranch };
  }

  if (!hasWorktreeDir) {
    const worktreeDir =
      worktreesToml?.worktreeDir ?? (await detectWorktreeDir(options.repoRoot));
    output.naming = { ...(output.naming ?? {}), worktreeDir };
  }

  if (!hasBranchPrefix) {
    const branchBase =
      defaultBranch ??
      (isRecord(baseConfig) && isRecord(baseConfig['repo'])
        ? (baseConfig['repo']['defaultBranch'] as string | undefined)
        : undefined) ??
      'main';
    const inferredPrefix = await detectBranchPrefix(options.repoRoot, branchBase);
    if (inferredPrefix) {
      output.naming = { ...(output.naming ?? {}), branchPrefix: inferredPrefix };
    }
  }

  if (!hasGitHubOwner || !hasGitHubRepo) {
    const github =
      worktreesToml?.githubOwner && worktreesToml.githubRepo
        ? { owner: worktreesToml.githubOwner, repo: worktreesToml.githubRepo }
        : await detectGitHubRepo(options.repoRoot);
    if (github) {
      output.github = {
        ...(output.github ?? {}),
        ...(hasGitHubOwner ? {} : { owner: github.owner }),
        ...(hasGitHubRepo ? {} : { repo: github.repo }),
      };
    }
  }

  if (!hasProviders) {
    const enabled = new Set<TaskProvider>();
    enabled.add('local');
    const hasGitHubToken = Boolean(
      readEnvValue('GITHUB_TOKEN') ?? readEnvValue('GH_TOKEN'),
    );
    const hasLinearToken = Boolean(readEnvValue('LINEAR_API_KEY'));
    if (hasGitHubToken) enabled.add('github');
    if (hasLinearToken) enabled.add('linear');
    const normalized = normalizeProviders([...enabled]);
    let defaultProvider: TaskProvider = 'local';
    if (worktreesToml?.linearTeamKey && normalized.includes('linear')) {
      defaultProvider = 'linear';
    } else if (normalized.includes('github')) {
      defaultProvider = 'github';
    } else if (normalized.includes('linear')) {
      defaultProvider = 'linear';
    }
    output.task = {
      ...(output.task ?? {}),
      providers: { enabled: normalized, default: defaultProvider },
    };
  }

  return output;
}

function configFromEnv(): ConfigInput {
  const override: ConfigInput = {};
  const env = (key: string): EnvValue => readEnvValue(key);

  const githubToken = env('GITHUB_TOKEN') ?? env('GH_TOKEN');
  if (githubToken) {
    override.github = { ...(override.github ?? {}), token: githubToken };
  }

  const linearToken = env('LINEAR_API_KEY');
  if (linearToken) {
    override.linear = { ...(override.linear ?? {}), token: linearToken };
  }

  const claudeModel = env('CLAUDE_MODEL');
  if (claudeModel) {
    override.ai = {
      ...(override.ai ?? {}),
      models: { ...(override.ai?.models ?? {}), default: claudeModel },
    };
  }

  const phaseModels: Array<[keyof NonNullable<Config['ai']>['models'], string]> = [
    ['plan', 'SILVAN_MODEL_PLAN'],
    ['execute', 'SILVAN_MODEL_EXECUTE'],
    ['review', 'SILVAN_MODEL_REVIEW'],
    ['verify', 'SILVAN_MODEL_VERIFY'],
    ['pr', 'SILVAN_MODEL_PR'],
    ['recovery', 'SILVAN_MODEL_RECOVERY'],
  ];
  for (const [phase, key] of phaseModels) {
    const value = env(key);
    if (!value) continue;
    override.ai = {
      ...(override.ai ?? {}),
      models: { ...(override.ai?.models ?? {}), [phase]: value },
    };
  }

  const maxTurns = parseNumber(env('SILVAN_MAX_TURNS'));
  const maxBudgetUsd = parseNumber(env('SILVAN_MAX_BUDGET_USD'));
  const maxThinkingTokens = parseNumber(env('SILVAN_MAX_THINKING_TOKENS'));
  if (maxTurns || maxBudgetUsd || maxThinkingTokens) {
    override.ai = {
      ...(override.ai ?? {}),
      budgets: {
        ...(override.ai?.budgets ?? {}),
        default: {
          ...(override.ai?.budgets?.default ?? {}),
          ...(maxTurns ? { maxTurns } : {}),
          ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
          ...(maxThinkingTokens ? { maxThinkingTokens } : {}),
        },
      },
    };
  }

  const phaseBudgets: Array<
    [keyof NonNullable<Config['ai']>['budgets'], string, string, string]
  > = [
    [
      'plan',
      'SILVAN_MAX_TURNS_PLAN',
      'SILVAN_MAX_BUDGET_USD_PLAN',
      'SILVAN_MAX_THINKING_TOKENS_PLAN',
    ],
    [
      'execute',
      'SILVAN_MAX_TURNS_EXECUTE',
      'SILVAN_MAX_BUDGET_USD_EXECUTE',
      'SILVAN_MAX_THINKING_TOKENS_EXECUTE',
    ],
    [
      'review',
      'SILVAN_MAX_TURNS_REVIEW',
      'SILVAN_MAX_BUDGET_USD_REVIEW',
      'SILVAN_MAX_THINKING_TOKENS_REVIEW',
    ],
    [
      'verify',
      'SILVAN_MAX_TURNS_VERIFY',
      'SILVAN_MAX_BUDGET_USD_VERIFY',
      'SILVAN_MAX_THINKING_TOKENS_VERIFY',
    ],
    [
      'pr',
      'SILVAN_MAX_TURNS_PR',
      'SILVAN_MAX_BUDGET_USD_PR',
      'SILVAN_MAX_THINKING_TOKENS_PR',
    ],
    [
      'recovery',
      'SILVAN_MAX_TURNS_RECOVERY',
      'SILVAN_MAX_BUDGET_USD_RECOVERY',
      'SILVAN_MAX_THINKING_TOKENS_RECOVERY',
    ],
  ];
  for (const [phase, turnsKey, budgetKey, thinkingKey] of phaseBudgets) {
    const turns = parseNumber(env(turnsKey));
    const budget = parseNumber(env(budgetKey));
    const thinking = parseNumber(env(thinkingKey));
    if (!turns && !budget && !thinking) continue;
    override.ai = {
      ...(override.ai ?? {}),
      budgets: {
        ...(override.ai?.budgets ?? {}),
        [phase]: {
          ...(override.ai?.budgets?.[phase] ?? {}),
          ...(turns ? { maxTurns: turns } : {}),
          ...(budget ? { maxBudgetUsd: budget } : {}),
          ...(thinking ? { maxThinkingTokens: thinking } : {}),
        },
      },
    };
  }

  const maxCalls = parseNumber(env('SILVAN_MAX_TOOL_CALLS'));
  const maxDurationMs = parseNumber(env('SILVAN_MAX_TOOL_MS'));
  if (maxCalls || maxDurationMs) {
    override.ai = {
      ...(override.ai ?? {}),
      toolLimits: {
        ...(override.ai?.toolLimits ?? {}),
        ...(maxCalls ? { maxCalls } : {}),
        ...(maxDurationMs ? { maxDurationMs } : {}),
      },
    };
  }

  const persistSessions = parseBool(env('SILVAN_PERSIST_SESSIONS'));
  if (persistSessions !== undefined) {
    override.ai = {
      ...(override.ai ?? {}),
      sessions: { ...(override.ai?.sessions ?? {}), persist: persistSessions },
    };
  }

  const cognitionDefaults = parseBool(env('SILVAN_COGNITION_DEFAULTS'));
  if (cognitionDefaults !== undefined) {
    override.features = {
      ...(override.features ?? {}),
      cognitionDefaults,
    };
  }

  const cognitionProvider = env('SILVAN_COGNITION_PROVIDER');
  if (cognitionProvider) {
    override.ai = {
      ...(override.ai ?? {}),
      cognition: {
        ...(override.ai?.cognition ?? {}),
        provider: cognitionProvider as Config['ai']['cognition']['provider'],
      },
    };
  }

  const cognitionModels: Array<
    [keyof NonNullable<Config['ai']>['cognition']['modelByTask'], string]
  > = [
    ['kickoffPrompt', 'SILVAN_COGNITION_MODEL_KICKOFF'],
    ['initDefaults', 'SILVAN_COGNITION_MODEL_INIT_DEFAULTS'],
    ['plan', 'SILVAN_COGNITION_MODEL_PLAN'],
    ['reviewKickoff', 'SILVAN_COGNITION_MODEL_REVIEW'],
    ['reviewCluster', 'SILVAN_COGNITION_MODEL_REVIEW'],
    ['localReview', 'SILVAN_COGNITION_MODEL_REVIEW'],
    ['ciTriage', 'SILVAN_COGNITION_MODEL_CI'],
    ['verificationSummary', 'SILVAN_COGNITION_MODEL_VERIFY'],
    ['recovery', 'SILVAN_COGNITION_MODEL_RECOVERY'],
    ['prDraft', 'SILVAN_COGNITION_MODEL_PR'],
    ['conversationSummary', 'SILVAN_COGNITION_MODEL_CONVERSATION_SUMMARY'],
  ];
  for (const [task, key] of cognitionModels) {
    const value = env(key);
    if (!value) continue;
    override.ai = {
      ...(override.ai ?? {}),
      cognition: {
        ...(override.ai?.cognition ?? {}),
        modelByTask: {
          ...(override.ai?.cognition?.modelByTask ?? {}),
          [task]: value,
        },
      },
    };
  }

  const reviewLoops = parseNumber(env('SILVAN_MAX_REVIEW_LOOPS'));
  if (reviewLoops) {
    override.review = { ...(override.review ?? {}), maxIterations: reviewLoops };
  }

  const shell = env('SHELL');
  if (shell) {
    override.verify = { ...(override.verify ?? {}), shell };
  }

  const stateMode = env('SILVAN_STATE_MODE');
  if (stateMode === 'global' || stateMode === 'repo') {
    override.state = { ...(override.state ?? {}), mode: stateMode };
  }

  return override;
}

export async function loadConfig(
  overrides?: ConfigInput,
  options?: { cwd?: string },
): Promise<ConfigResult> {
  const explorer = cosmiconfig('silvan', {
    searchPlaces: [
      'silvan.config.ts',
      'silvan.config.js',
      'silvan.config.json',
      'silvan.config.yaml',
      'silvan.config.yml',
      'package.json',
    ],
    loaders: {
      '.ts': loadTsConfig,
    },
  });

  const searchFrom = options?.cwd ? resolve(options.cwd) : process.cwd();
  const configPath = await findConfigPath(searchFrom);
  const repoRoot =
    configPath !== null
      ? dirname(configPath)
      : ((await resolveGitRoot(searchFrom)) ?? searchFrom);
  const result = configPath ? await explorer.load(configPath) : null;
  const projectRoot = repoRoot;
  await loadProjectEnv({
    cwd: searchFrom,
    ...(configPath ? { configPath } : {}),
  });
  const worktreesToml = await loadWorktreesToml(repoRoot);

  const baseConfig: unknown = result ? (result.config ?? {}) : {};
  const parsed = configSchema.safeParse(baseConfig);
  if (!parsed.success) {
    const writer = new ProseWriter();
    const issueLines = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`,
    );
    const issueBlock = issueLines.reduce(
      (acc, line, index) => `${acc}${index ? '\n' : ''}${line}`,
      '',
    );
    writer.write(issueBlock);
    const message = writer.toString().trimEnd();
    throw new SilvanError({
      code: 'config.invalid',
      message: `Invalid config: ${message}`,
      userMessage: 'Configuration file is invalid.',
      kind: 'validation',
      details: {
        issues: issueLines,
        ...(result?.filepath ? { path: result.filepath } : {}),
      },
      nextSteps: [
        'Run `silvan config validate` for a full report.',
        'Fix the invalid settings in your config file.',
      ],
    });
  }
  const inferredDefaults = await inferConfigDefaults({
    repoRoot,
    baseConfig,
    worktreesToml,
  });
  const envOverrides = configFromEnv();
  const merged = mergeConfig(
    mergeConfig(mergeConfig(parsed.data, inferredDefaults), envOverrides),
    overrides,
  );
  const finalParsed = configSchema.safeParse(merged);
  if (!finalParsed.success) {
    const issueLines = finalParsed.error.issues.map(
      (issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`,
    );
    throw new SilvanError({
      code: 'config.invalid',
      message: `Invalid config overrides: ${issueLines.join('; ')}`,
      userMessage: 'Configuration overrides are invalid.',
      kind: 'validation',
      details: {
        issues: issueLines,
        ...(result?.filepath ? { path: result.filepath } : {}),
      },
      nextSteps: ['Run `silvan config validate` to review configuration issues.'],
    });
  }
  const finalConfig = finalParsed.data;
  if (!configPath && shouldShowMissingConfigNotice()) {
    console.log(renderMissingConfigNotice(finalConfig, projectRoot));
  }

  return {
    config: finalConfig,
    source: result
      ? { path: result.filepath, format: result.isEmpty ? 'empty' : 'file' }
      : null,
    projectRoot,
  };
}
