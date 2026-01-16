import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import type { ConfigInput } from './schema';

type InitAnswers = {
  branchPrefix: string;
  worktreeDir: string;
  enabledProviders: Array<'local' | 'github' | 'linear'>;
  requestCopilot: boolean;
  verifyCommands: Array<{ name: string; cmd: string }>;
};

const defaultBranchPrefix = 'feature/';
const defaultWorktreeDir = '.worktrees';

function formatStringArray(values: string[]): string {
  return `[${values.map((value) => `'${value}'`).join(', ')}]`;
}

function formatConfig(answers: InitAnswers): string {
  const lines: string[] = [
    "import { defineConfig } from 'silvan/config';",
    '',
    'export default defineConfig({',
    '  naming: {',
    `    branchPrefix: '${answers.branchPrefix}',`,
    `    worktreeDir: '${answers.worktreeDir}',`,
    '  },',
  ];

  if (answers.enabledProviders.length > 0) {
    lines.push('  task: {');
    lines.push('    providers: {');
    lines.push(`      enabled: ${formatStringArray(answers.enabledProviders)},`);
    lines.push(`      default: '${answers.enabledProviders[0]}',`);
    lines.push('    },');
    lines.push('  },');
  }

  if (answers.verifyCommands.length > 0) {
    lines.push('  verify: {');
    lines.push('    commands: [');
    for (const command of answers.verifyCommands) {
      lines.push(`      { name: '${command.name}', cmd: '${command.cmd}' },`);
    }
    lines.push('    ],');
    lines.push('  },');
  }

  if (answers.enabledProviders.includes('github')) {
    lines.push('  github: {');
    lines.push(`    requestCopilot: ${answers.requestCopilot},`);
    lines.push('    reviewers: [],');
    lines.push('  },');
  }

  lines.push('});');
  lines.push('');

  return `${lines.join('\n')}`;
}

async function readPackageScripts(repoRoot: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(repoRoot, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` (${defaultValue})` : '';
    const response = await rl.question(`${question}${suffix}: `);
    const trimmed = response.trim();
    return trimmed || defaultValue || '';
  } finally {
    rl.close();
  }
}

async function promptYesNo(question: string, defaultValue = true): Promise<boolean> {
  const defaultLabel = defaultValue ? 'Y/n' : 'y/N';
  const response = await prompt(`${question} [${defaultLabel}]`);
  if (!response) return defaultValue;
  const normalized = response.toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

export async function promptInitAnswers(repoRoot: string): Promise<InitAnswers> {
  const scripts = await readPackageScripts(repoRoot);
  const verifyCommands: Array<{ name: string; cmd: string }> = [];
  const knownScripts = ['lint', 'typecheck', 'test'];

  const branchPrefix = await prompt('Branch prefix', defaultBranchPrefix);
  const worktreeDir = await prompt('Worktree directory', defaultWorktreeDir);

  const enableGitHub = await promptYesNo('Enable GitHub task provider?', false);
  const enableLinear = await promptYesNo('Enable Linear task provider?', false);

  const enabledProviders: Array<'local' | 'github' | 'linear'> = ['local'];
  if (enableGitHub) enabledProviders.push('github');
  if (enableLinear) enabledProviders.push('linear');

  let requestCopilot = true;
  if (enableGitHub) {
    requestCopilot = await promptYesNo('Request Copilot reviews by default?', true);
  }

  if (Object.keys(scripts).length > 0) {
    const useDefaults = await promptYesNo(
      'Include common verify commands (lint/typecheck/test) if available?',
      true,
    );
    if (useDefaults) {
      for (const name of knownScripts) {
        if (scripts[name]) {
          verifyCommands.push({ name, cmd: `bun run ${name}` });
        }
      }
    }
  }

  return {
    branchPrefix,
    worktreeDir,
    enabledProviders,
    requestCopilot,
    verifyCommands,
  };
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
    // ok
  }

  const config: ConfigInput = {
    naming: { branchPrefix: answers.branchPrefix, worktreeDir: answers.worktreeDir },
    task: {
      providers: {
        enabled: answers.enabledProviders,
        default: answers.enabledProviders[0] ?? 'local',
      },
    },
  };

  if (answers.verifyCommands.length > 0) {
    config.verify = { commands: answers.verifyCommands };
  }

  if (answers.enabledProviders.includes('github')) {
    config.github = {
      requestCopilot: answers.requestCopilot,
      reviewers: [],
      review: {
        requireApproval: false,
        requiredApprovals: 1,
        pollIntervalMs: 15000,
        timeoutMs: 900000,
      },
    };
  }

  const contents = formatConfig(answers);
  await writeFile(configPath, contents, 'utf-8');
  return { path: configPath, config };
}
