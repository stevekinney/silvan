import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { cosmiconfig } from 'cosmiconfig';
import { ProseWriter } from 'prose-writer';

import { SilvanError } from '../core/errors';
import { readEnvValue } from '../utils/env';
import { loadProjectEnv } from './env';
import type { Config, ConfigInput } from './schema';
import { configSchema } from './schema';

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
  const result = configPath ? await explorer.load(configPath) : null;
  const projectRoot = configPath ? dirname(configPath) : searchFrom;
  await loadProjectEnv({
    cwd: searchFrom,
    ...(configPath ? { configPath } : {}),
  });

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
  const envOverrides = configFromEnv();
  const merged = mergeConfig(mergeConfig(parsed.data, envOverrides), overrides);
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

  return {
    config: finalConfig,
    source: result
      ? { path: result.filepath, format: result.isEmpty ? 'empty' : 'file' }
      : null,
    projectRoot,
  };
}
