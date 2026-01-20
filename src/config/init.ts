import { access, copyFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import chalk from 'chalk';
import { cosmiconfig } from 'cosmiconfig';

import { readEnvValue } from '../utils/env';
import { loadProjectEnv } from './env';
import { findConfigPath } from './load';
import type { ConfigInput } from './schema';
import { parseGitHubRemote } from './validate';

type TaskProvider = 'github' | 'linear' | 'local';
type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

type VerifyCommand = { name: string; cmd: string };

export type InitAnswers = {
  worktreeDir: string;
  enabledProviders: TaskProvider[];
  defaultProvider: TaskProvider;
  verifyCommands: VerifyCommand[];
};

export type InitContext = {
  repoRoot: string;
  detection: InitDetection;
  existingConfig?: ConfigInput;
  existingConfigPath?: string;
};

export type InitResult = {
  action: 'created' | 'updated' | 'skipped';
  path?: string;
  backupPath?: string;
  changes?: string[];
};

type InitDetection = {
  worktreeDir: string;
  verifyCommands: VerifyCommand[];
  packageManager: PackageManager;
  defaultBranch: string;
  github?: { owner: string; repo: string };
};

async function gitStdout(args: string[], repoRoot: string): Promise<string | null> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function detectGitHubRepo(
  repoRoot: string,
): Promise<{ owner: string; repo: string } | null> {
  const remote = await gitStdout(['remote', 'get-url', 'origin'], repoRoot);
  if (!remote) return null;
  return parseGitHubRemote(remote);
}

async function detectDefaultBranch(repoRoot: string): Promise<string> {
  const headRef = await gitStdout(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot);
  if (!headRef) return 'main';
  const parts = headRef.split('/');
  return parts[parts.length - 1] || 'main';
}

async function detectWorktreeDir(repoRoot: string): Promise<string> {
  const candidates = ['.worktrees', 'worktrees', '.trees'];

  for (const dir of candidates) {
    const path = join(repoRoot, dir);
    try {
      const entries = await readdir(path);
      if (entries.length >= 0) {
        return dir;
      }
    } catch {
      // Directory doesn't exist, continue.
    }
  }

  return '.worktrees';
}

async function readPackageScripts(repoRoot: string): Promise<Record<string, string>> {
  try {
    const raw = await Bun.file(join(repoRoot, 'package.json')).text();
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

async function detectPackageManager(repoRoot: string): Promise<PackageManager> {
  const lockfiles: Array<[string, PackageManager]> = [
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ];

  for (const [lockfile, manager] of lockfiles) {
    try {
      await access(join(repoRoot, lockfile));
      return manager;
    } catch {
      // Not found, continue.
    }
  }

  return 'bun';
}

function formatScriptCommand(manager: PackageManager, script: string): string {
  switch (manager) {
    case 'yarn':
      return `yarn ${script}`;
    case 'pnpm':
      return `pnpm run ${script}`;
    case 'npm':
      return `npm run ${script}`;
    case 'bun':
    default:
      return `bun run ${script}`;
  }
}

async function detectVerifyScripts(
  repoRoot: string,
  manager: PackageManager,
): Promise<VerifyCommand[]> {
  const scripts = await readPackageScripts(repoRoot);

  const categories: Record<string, string[]> = {
    lint: ['lint', 'lint:fix', 'eslint'],
    typecheck: ['typecheck', 'type-check', 'tsc', 'types'],
    test: ['test', 'test:unit', 'vitest', 'jest'],
    format: ['format', 'format:check', 'prettier'],
  };

  const detected: VerifyCommand[] = [];

  for (const [category, candidates] of Object.entries(categories)) {
    const found = candidates.find((c) => scripts[c]);
    if (found) {
      detected.push({ name: category, cmd: formatScriptCommand(manager, found) });
    }
  }

  return detected;
}

async function loadConfigFile(path: string): Promise<ConfigInput | undefined> {
  const explorer = cosmiconfig('silvan', {
    loaders: {
      '.ts': async (path) => {
        const module = (await import(pathToFileURL(path).toString())) as {
          default?: unknown;
          config?: unknown;
        };
        return module.default ?? module.config ?? module;
      },
    },
  });

  const result = await explorer.load(path);
  if (!result || !result.config || typeof result.config !== 'object') {
    return undefined;
  }
  return result.config as ConfigInput;
}

function normalizeProviders(
  values: TaskProvider[],
): Array<'local' | 'github' | 'linear'> {
  const unique = new Set<TaskProvider>(values);
  if (unique.size === 0) {
    unique.add('local');
  }
  const order: TaskProvider[] = ['local', 'github', 'linear'];
  return order.filter((provider) => unique.has(provider));
}

export async function collectInitContext(repoRoot: string): Promise<InitContext> {
  const existingConfigPath = await findConfigPath(repoRoot);
  await loadProjectEnv({
    cwd: repoRoot,
    ...(existingConfigPath ? { configPath: existingConfigPath } : {}),
  });

  const [worktreeDir, packageManager, defaultBranch, githubResult] = await Promise.all([
    detectWorktreeDir(repoRoot),
    detectPackageManager(repoRoot),
    detectDefaultBranch(repoRoot),
    detectGitHubRepo(repoRoot),
  ]);
  const verifyCommands = await detectVerifyScripts(repoRoot, packageManager);
  const github = githubResult ?? undefined;
  const existingConfig = existingConfigPath
    ? await loadConfigFile(existingConfigPath)
    : undefined;

  return {
    repoRoot,
    detection: {
      worktreeDir,
      verifyCommands,
      packageManager,
      defaultBranch,
      ...(github ? { github } : {}),
    },
    ...(existingConfigPath ? { existingConfigPath } : {}),
    ...(existingConfig ? { existingConfig } : {}),
  };
}

export function getInitDefaults(context: InitContext): InitAnswers {
  const enabled = new Set<TaskProvider>();
  enabled.add('local');
  if (context.detection.github) {
    enabled.add('github');
  }
  if (readEnvValue('LINEAR_API_KEY')) {
    enabled.add('linear');
  }
  const normalized = normalizeProviders([...enabled]);

  return {
    worktreeDir: context.detection.worktreeDir,
    enabledProviders: normalized,
    defaultProvider: normalized[0] ?? 'local',
    verifyCommands: context.detection.verifyCommands,
  };
}

async function promptProviders(
  rl: ReturnType<typeof createInterface>,
  defaults: TaskProvider[],
): Promise<TaskProvider[]> {
  const options: Array<{ label: string; value: TaskProvider }> = [
    { label: 'Local tasks', value: 'local' },
    { label: 'GitHub Issues', value: 'github' },
    { label: 'Linear', value: 'linear' },
  ];

  console.log('Task providers (comma-separated):');
  options.forEach((option, index) => {
    const enabled = defaults.includes(option.value) ? chalk.green('✓') : ' ';
    console.log(`  ${index + 1}) [${enabled}] ${option.label}`);
  });

  const response = await rl.question(
    chalk.dim(`Enter choices [${defaults.join(', ')}]: `),
  );
  const trimmed = response.trim();
  if (!trimmed) return defaults;

  const selected = new Set<number>();
  for (const token of trimmed.split(/[\s,]+/)) {
    const choice = parseInt(token, 10);
    if (!Number.isNaN(choice)) {
      selected.add(choice);
    }
  }

  const enabledProviders = options
    .filter((_, index) => selected.has(index + 1))
    .map((option) => option.value);

  return normalizeProviders(enabledProviders);
}

async function promptDefaultProvider(
  rl: ReturnType<typeof createInterface>,
  options: TaskProvider[],
  defaultValue: TaskProvider,
): Promise<TaskProvider> {
  if (options.length <= 1) return options[0] ?? defaultValue;

  console.log('');
  console.log('Default provider:');
  options.forEach((option, index) => {
    const marker = option === defaultValue ? chalk.green('•') : ' ';
    console.log(`  ${index + 1}) ${marker} ${option}`);
  });
  const response = await rl.question(chalk.dim(`Enter choice [${defaultValue}]: `));
  const trimmed = response.trim();
  if (!trimmed) return defaultValue;
  const idx = Number.parseInt(trimmed, 10);
  if (Number.isNaN(idx) || idx < 1 || idx > options.length) {
    return defaultValue;
  }
  return options[idx - 1] ?? defaultValue;
}

async function promptWorktreeDir(
  rl: ReturnType<typeof createInterface>,
  defaultValue: string,
): Promise<string> {
  const response = await rl.question(chalk.dim(`Worktree directory [${defaultValue}]: `));
  const trimmed = response.trim();
  return trimmed.length > 0 ? trimmed : defaultValue;
}

export async function promptInitAnswers(context: InitContext): Promise<InitAnswers> {
  const defaults = getInitDefaults(context);
  const existing = context.existingConfig;

  const answers: InitAnswers = {
    worktreeDir: existing?.naming?.worktreeDir ?? defaults.worktreeDir,
    enabledProviders: existing?.task?.providers?.enabled ?? defaults.enabledProviders,
    defaultProvider: defaults.defaultProvider ?? 'local',
    verifyCommands: existing?.verify?.commands ?? defaults.verifyCommands,
  };
  const fallbackDefault =
    answers.enabledProviders[0] ?? defaults.defaultProvider ?? 'local';
  answers.defaultProvider = existing?.task?.providers?.default ?? fallbackDefault;

  const needsProviderPrompt = !existing?.task?.providers?.enabled;
  const needsDefaultProviderPrompt = !existing?.task?.providers?.default;
  const needsWorktreePrompt = !existing?.naming?.worktreeDir;

  if (!needsProviderPrompt && !needsDefaultProviderPrompt && !needsWorktreePrompt) {
    return answers;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (needsProviderPrompt) {
      answers.enabledProviders = await promptProviders(rl, defaults.enabledProviders);
      answers.defaultProvider =
        answers.enabledProviders[0] ?? defaults.defaultProvider ?? 'local';
    }
    if (needsDefaultProviderPrompt) {
      answers.defaultProvider = await promptDefaultProvider(
        rl,
        answers.enabledProviders,
        answers.defaultProvider,
      );
    }
    if (needsWorktreePrompt) {
      answers.worktreeDir = await promptWorktreeDir(rl, defaults.worktreeDir);
    }
  } finally {
    rl.close();
  }

  return {
    ...answers,
    enabledProviders: normalizeProviders(answers.enabledProviders),
  };
}

function buildInitConfigValues(
  answers: InitAnswers,
  detection: InitDetection,
): ConfigInput {
  const enabledProviders = normalizeProviders(answers.enabledProviders);
  const defaultProvider = enabledProviders.includes(answers.defaultProvider)
    ? answers.defaultProvider
    : (enabledProviders[0] ?? 'local');

  const config: ConfigInput = {
    naming: { worktreeDir: answers.worktreeDir },
    task: {
      providers: {
        enabled: enabledProviders,
        default: defaultProvider,
      },
    },
    repo: {
      defaultBranch: detection.defaultBranch,
    },
  };

  if (detection.github) {
    config.github = {
      owner: detection.github.owner,
      repo: detection.github.repo,
    };
  }

  if (answers.verifyCommands.length > 0) {
    config.verify = { commands: answers.verifyCommands };
  }

  return config;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyMissingConfig(
  base: ConfigInput,
  updates: ConfigInput,
  prefix = '',
  changes: string[] = [],
): ConfigInput {
  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };

  for (const [key, updateValue] of Object.entries(updates)) {
    if (updateValue === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const baseValue = output[key];

    if (Array.isArray(updateValue)) {
      if (!Array.isArray(baseValue) || baseValue.length === 0) {
        output[key] = updateValue;
        changes.push(path);
      }
      continue;
    }

    if (isPlainObject(updateValue)) {
      if (isPlainObject(baseValue)) {
        output[key] = applyMissingConfig(
          baseValue as ConfigInput,
          updateValue as ConfigInput,
          path,
          changes,
        );
      } else if (baseValue === undefined || baseValue === null) {
        applyMissingConfig({}, updateValue as ConfigInput, path, changes);
        output[key] = updateValue;
      }
      continue;
    }

    if (baseValue === undefined || baseValue === null || baseValue === '') {
      output[key] = updateValue;
      changes.push(path);
    }
  }

  return output as ConfigInput;
}

function formatString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function formatKey(key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return key;
  }
  return formatString(key);
}

function formatValue(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  const padInner = ' '.repeat(indent + 2);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => `${padInner}${formatValue(item, indent + 2)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(
      ([, entryValue]) => entryValue !== undefined,
    );
    if (entries.length === 0) return '{}';
    const lines = entries.map(
      ([key, entryValue]) =>
        `${padInner}${formatKey(key)}: ${formatValue(entryValue, indent + 2)}`,
    );
    return `{\n${lines.join(',\n')}\n${pad}}`;
  }

  if (typeof value === 'string') return formatString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return 'undefined';
}

function formatConfig(config: ConfigInput): string {
  const body = formatValue(config, 0);
  return [
    "import { defineConfig } from 'silvan/config';",
    '',
    `export default defineConfig(${body});`,
    '',
  ].join('\n');
}

export async function writeInitConfig(
  context: InitContext,
  answers: InitAnswers,
  options?: { updateExisting?: boolean },
): Promise<InitResult> {
  const targetPath =
    context.existingConfigPath ?? join(context.repoRoot, 'silvan.config.ts');
  const updates = buildInitConfigValues(answers, context.detection);

  if (context.existingConfigPath && context.existingConfig) {
    const changes: string[] = [];
    const merged = applyMissingConfig(context.existingConfig, updates, '', changes);
    if (changes.length === 0) {
      return { action: 'skipped', path: targetPath };
    }
    if (options?.updateExisting === false) {
      return { action: 'skipped', path: targetPath, changes };
    }

    const backupPath = `${targetPath}.bak`;
    await copyFile(targetPath, backupPath);
    await writeFile(targetPath, formatConfig(merged), 'utf-8');
    return { action: 'updated', path: targetPath, backupPath, changes };
  }

  await writeFile(targetPath, formatConfig(updates), 'utf-8');
  return { action: 'created', path: targetPath };
}
