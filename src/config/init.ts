import { access, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import chalk from 'chalk';

import type { ConfigInput } from './schema';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type TaskProvider = 'github' | 'linear' | 'local';

type InitAnswers = {
  worktreeDir: string;
  enabledProviders: TaskProvider[];
  verifyCommands: Array<{ name: string; cmd: string }>;
};

// -----------------------------------------------------------------------------
// UI Helpers
// -----------------------------------------------------------------------------

const ui = {
  header: (text: string) => console.log(chalk.bold.blue(`\n  ${text}\n`)),
  info: (text: string) => console.log(chalk.blue('ℹ ') + text),
  success: (text: string) => console.log(chalk.green('✓ ') + text),
  dim: (text: string) => chalk.dim(text),
  bullet: (label: string, value: string) =>
    console.log(
      `  ${chalk.dim('•')} ${chalk.cyan(label.padEnd(12))} ${chalk.dim('→')} ${value}`,
    ),
};

// -----------------------------------------------------------------------------
// Detection Functions
// -----------------------------------------------------------------------------

async function detectWorktreeDir(repoRoot: string): Promise<string> {
  const candidates = ['.worktrees', 'worktrees', '.trees'];

  for (const dir of candidates) {
    const path = join(repoRoot, dir);
    try {
      const entries = await readdir(path);
      if (entries.length >= 0) {
        return dir; // Directory exists
      }
    } catch {
      // Directory doesn't exist, continue
    }
  }

  return '.worktrees'; // Default
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

async function detectVerifyScripts(
  repoRoot: string,
): Promise<Array<{ name: string; cmd: string }>> {
  const scripts = await readPackageScripts(repoRoot);

  // Priority order - first match wins for each category
  const categories: Record<string, string[]> = {
    lint: ['lint', 'lint:fix', 'eslint'],
    typecheck: ['typecheck', 'type-check', 'tsc', 'types'],
    test: ['test', 'test:unit', 'vitest', 'jest'],
    format: ['format', 'format:check', 'prettier'],
  };

  const detected: Array<{ name: string; cmd: string }> = [];

  for (const [category, candidates] of Object.entries(categories)) {
    const found = candidates.find((c) => scripts[c]);
    if (found) {
      detected.push({ name: category, cmd: `bun run ${found}` });
    }
  }

  return detected;
}

// -----------------------------------------------------------------------------
// Interactive Prompts
// -----------------------------------------------------------------------------

type ProviderOption = {
  label: string;
  value: TaskProvider;
};

const PROVIDER_OPTIONS: ProviderOption[] = [
  { label: 'GitHub Issues', value: 'github' },
  { label: 'Linear', value: 'linear' },
  { label: 'Neither (local only)', value: 'local' },
];

async function selectProviders(): Promise<TaskProvider[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.cyan('Task providers (multi-select):'));
  for (let i = 0; i < PROVIDER_OPTIONS.length; i++) {
    const option = PROVIDER_OPTIONS[i]!;
    console.log(`  ${chalk.dim(`${i + 1})`)} ${option.label}`);
  }

  try {
    const response = await rl.question(
      chalk.dim('Enter choices (e.g., 1,3). Leave blank for local only: '),
    );
    const trimmed = response.trim();
    if (!trimmed) return ['local'];

    const selected = new Set<number>();
    for (const token of trimmed.split(/[\s,]+/)) {
      const choice = parseInt(token, 10);
      if (!Number.isNaN(choice)) {
        selected.add(choice);
      }
    }

    const ordered = PROVIDER_OPTIONS.filter((_, index) => selected.has(index + 1)).map(
      (option) => option.value,
    );

    return ordered.length > 0 ? ordered : ['local'];
  } finally {
    rl.close();
  }
}

// -----------------------------------------------------------------------------
// Main Init Flow
// -----------------------------------------------------------------------------

export async function promptInitAnswers(repoRoot: string): Promise<InitAnswers> {
  ui.header('Silvan Configuration');

  // Auto-detect worktree directory
  const worktreeDir = await detectWorktreeDir(repoRoot);
  ui.info(`Using worktree directory: ${chalk.cyan(worktreeDir)}`);
  console.log('');

  // Single provider selection
  const enabledProviders = await selectProviders();
  console.log('');

  // Auto-detect verify scripts
  const verifyCommands = await detectVerifyScripts(repoRoot);
  if (verifyCommands.length > 0) {
    ui.info('Detected verification commands:');
    for (const cmd of verifyCommands) {
      ui.bullet(cmd.name, cmd.cmd);
    }
  } else {
    ui.info('No verification scripts detected in package.json');
  }
  console.log('');

  return {
    worktreeDir,
    enabledProviders,
    verifyCommands,
  };
}

// -----------------------------------------------------------------------------
// Config Generation
// -----------------------------------------------------------------------------

function formatStringArray(values: string[]): string {
  return `[${values.map((value) => `'${value}'`).join(', ')}]`;
}

function formatConfig(answers: InitAnswers): string {
  const enabledProviders = normalizeProviders(answers.enabledProviders);

  const lines: string[] = [
    "import { defineConfig } from 'silvan/config';",
    '',
    'export default defineConfig({',
    '  naming: {',
    `    worktreeDir: '${answers.worktreeDir}',`,
    '  },',
  ];

  lines.push('  task: {');
  lines.push('    providers: {');
  lines.push(`      enabled: ${formatStringArray(enabledProviders)},`);
  lines.push(`      default: '${enabledProviders[0]}',`);
  lines.push('    },');
  lines.push('  },');

  if (answers.verifyCommands.length > 0) {
    lines.push('  verify: {');
    lines.push('    commands: [');
    for (const command of answers.verifyCommands) {
      lines.push(`      { name: '${command.name}', cmd: '${command.cmd}' },`);
    }
    lines.push('    ],');
    lines.push('  },');
  }

  lines.push('});');
  lines.push('');

  return `${lines.join('\n')}`;
}

export async function writeInitConfig(
  repoRoot: string,
  answers: InitAnswers,
): Promise<{ path: string; config: ConfigInput } | null> {
  const configPath = join(repoRoot, 'silvan.config.ts');
  try {
    await access(configPath);
    return null;
  } catch {
    // File doesn't exist, proceed
  }

  const enabledProviders = normalizeProviders(answers.enabledProviders);

  const config: ConfigInput = {
    naming: { worktreeDir: answers.worktreeDir },
    task: {
      providers: {
        enabled: enabledProviders,
        default: enabledProviders[0] ?? 'local',
      },
    },
  };

  if (answers.verifyCommands.length > 0) {
    config.verify = { commands: answers.verifyCommands };
  }

  const contents = formatConfig(answers);
  await writeFile(configPath, contents, 'utf-8');
  return { path: configPath, config };
}

// -----------------------------------------------------------------------------
// Defaults for --yes mode
// -----------------------------------------------------------------------------

export function getInitDefaults(repoRoot: string): Promise<InitAnswers> {
  return (async () => {
    const worktreeDir = await detectWorktreeDir(repoRoot);
    const verifyCommands = await detectVerifyScripts(repoRoot);

    return {
      worktreeDir,
      enabledProviders: ['local'],
      verifyCommands,
    };
  })();
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
