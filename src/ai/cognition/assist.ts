import { appendMessages, createConversation } from 'conversationalist';
import { ProseWriter } from 'prose-writer';
import { z } from 'zod';

import type { Config } from '../../config/schema';
import { configSchema } from '../../config/schema';
import type { SilvanError } from '../../core/errors';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import { hashInputs } from '../../prompts';
import { resolveStatePaths } from '../../state/paths';
import { readEnvValue } from '../../utils/env';
import { hashString } from '../../utils/hash';
import { truncateLines, truncateText } from '../../utils/text';
import { invokeCognition } from '../router';

const assistSchema = z
  .object({
    summary: z.string().optional(),
    steps: z.array(z.string()).default([]),
  })
  .strict();

type AssistOutput = z.infer<typeof assistSchema>;

export type AssistSuggestion = {
  summary?: string;
  steps: string[];
};

type VerifyFailure = {
  name: string;
  exitCode: number;
  stderr: string;
};

const MAX_SUMMARY_LENGTH = 180;
const MAX_STEP_LENGTH = 160;
const MAX_STEPS = 5;

function stripControlChars(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      output += ' ';
      continue;
    }
    output += value[index] ?? '';
  }
  return output;
}

function cleanLine(value: string, maxLength: number): string {
  const sanitized = stripControlChars(value).replace(/\s+/g, ' ').trim();
  return truncateText(sanitized, maxLength);
}

function sanitizeSteps(steps: string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const step of steps) {
    const line = cleanLine(step, MAX_STEP_LENGTH);
    if (!line || seen.has(line)) continue;
    cleaned.push(line);
    seen.add(line);
    if (cleaned.length >= MAX_STEPS) break;
  }
  return cleaned;
}

function sanitizeAssistOutput(output: AssistOutput): AssistSuggestion | null {
  const summary = output.summary
    ? cleanLine(output.summary, MAX_SUMMARY_LENGTH)
    : undefined;
  const steps = sanitizeSteps(output.steps ?? []);
  if (!summary && steps.length === 0) return null;
  return { ...(summary ? { summary } : {}), steps };
}

function sanitizeDetails(
  details?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (/token|secret|password|api[_-]?key/i.test(key)) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      safe[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      safe[key] = value.slice(0, 12);
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function parseProvider(
  value: string | undefined,
): Config['ai']['cognition']['provider'] | undefined {
  if (value === 'anthropic' || value === 'openai' || value === 'gemini') {
    return value;
  }
  return undefined;
}

function buildFallbackConfig(): Config {
  const base = configSchema.parse({});
  const provider =
    parseProvider(readEnvValue('SILVAN_COGNITION_PROVIDER')) ??
    base.ai.cognition.provider;
  const modelByTask = { ...base.ai.cognition.modelByTask };
  const recoveryModel = readEnvValue('SILVAN_COGNITION_MODEL_RECOVERY');
  if (recoveryModel) {
    modelByTask.recovery = recoveryModel;
  }
  const verifyModel = readEnvValue('SILVAN_COGNITION_MODEL_VERIFY');
  if (verifyModel) {
    modelByTask.verificationSummary = verifyModel;
  }

  return {
    ...base,
    ai: {
      ...base.ai,
      cognition: {
        ...base.ai.cognition,
        provider,
        modelByTask,
      },
    },
  };
}

function canUseCognition(config: Config): boolean {
  const provider = config.ai.cognition.provider;
  if (provider === 'openai') return Boolean(readEnvValue('OPENAI_API_KEY'));
  if (provider === 'gemini') return Boolean(readEnvValue('GEMINI_API_KEY'));
  return Boolean(readEnvValue('ANTHROPIC_API_KEY'));
}

async function runAssist(options: {
  title: string;
  kind: 'recovery' | 'verification';
  system: string;
  input: Record<string, unknown>;
  task: Parameters<typeof invokeCognition>[0]['task'];
  config?: Config;
  repoRoot?: string;
  cacheDir?: string;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<AssistSuggestion | null> {
  const config = options.config ?? buildFallbackConfig();
  if (!canUseCognition(config)) return null;

  const systemWriter = new ProseWriter();
  systemWriter.write(options.system);
  const userWriter = new ProseWriter();
  userWriter.write(JSON.stringify(options.input, null, 2));

  const conversation = createConversation({
    title: options.title,
    metadata: { kind: options.kind },
  });
  const withMessages = appendMessages(
    conversation,
    {
      role: 'system',
      content: systemWriter.toString().trimEnd(),
      metadata: { kind: options.kind },
    },
    {
      role: 'user',
      content: userWriter.toString().trimEnd(),
      metadata: { kind: options.kind },
    },
  );
  const snapshot = {
    conversation: withMessages,
    digest: hashString(JSON.stringify(withMessages)),
    updatedAt: new Date().toISOString(),
    path: 'memory',
  };

  const inputsDigest = hashInputs({ purpose: options.title, ...options.input });
  const repoRoot = options.repoRoot ?? process.cwd();
  const cacheDir =
    options.cacheDir ??
    resolveStatePaths({
      repoRoot,
      mode: config.state.mode,
      ...(config.state.root ? { stateRoot: config.state.root } : {}),
    }).cacheDir;

  const response = await invokeCognition({
    snapshot,
    task: options.task,
    schema: assistSchema,
    config,
    inputsDigest,
    cacheDir,
    ...(options.bus ? { bus: options.bus } : {}),
    ...(options.context ? { context: options.context } : {}),
    temperature: 0.2,
  });

  return sanitizeAssistOutput(response);
}

export async function suggestCliRecovery(options: {
  error: SilvanError;
  command?: string;
  repoRoot?: string;
  config?: Config;
  cacheDir?: string;
}): Promise<AssistSuggestion | null> {
  const safeDetails = sanitizeDetails(options.error.details);
  const input = {
    command: options.command ?? null,
    error: {
      code: options.error.code,
      kind: options.error.kind,
      message: options.error.userMessage,
      ...(safeDetails ? { details: safeDetails } : {}),
    },
  };
  const system =
    'You are a recovery assistant for Silvan CLI errors. ' +
    'Suggest safe, minimal next steps. Do not include secrets. ' +
    'Avoid destructive commands. Return JSON only with { summary?: string, steps: string[] }.';

  return runAssist({
    title: 'silvan:cli-recovery',
    kind: 'recovery',
    system,
    input,
    task: 'recovery',
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
  });
}

export async function suggestConfigRecovery(options: {
  error: SilvanError;
  repoRoot?: string;
  config?: Config;
  cacheDir?: string;
}): Promise<AssistSuggestion | null> {
  const safeDetails = sanitizeDetails(options.error.details);
  const input = {
    error: {
      code: options.error.code,
      message: options.error.userMessage,
      ...(safeDetails ? { details: safeDetails } : {}),
    },
  };
  const system =
    'You are a recovery assistant for Silvan configuration errors. ' +
    'Suggest minimal config fixes using the issues provided. ' +
    'Do not include secrets or invent values. Return JSON only with { summary?: string, steps: string[] }.';

  return runAssist({
    title: 'silvan:config-recovery',
    kind: 'recovery',
    system,
    input,
    task: 'recovery',
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
  });
}

export async function suggestVerificationRecovery(options: {
  report: { results: VerifyFailure[] };
  config: Config;
  repoRoot: string;
  cacheDir?: string;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<AssistSuggestion | null> {
  const commandLookup = new Map(
    options.config.verify.commands.map((command) => [command.name, command.cmd]),
  );
  const failures = options.report.results.map((result) => {
    const excerpt = truncateLines(result.stderr ?? '', {
      maxLines: 10,
      maxChars: 1600,
    });
    return {
      name: result.name,
      exitCode: result.exitCode,
      ...(commandLookup.get(result.name)
        ? { command: commandLookup.get(result.name) }
        : {}),
      stderr: excerpt.lines.join('\n'),
      truncated: excerpt.truncated,
    };
  });

  const input = {
    failures,
  };
  const system =
    'You are a verification recovery assistant for Silvan. ' +
    'Given failed verification commands and stderr excerpts, suggest safe, minimal fixes. ' +
    'Prefer actionable steps like rerunning a command or fixing a missing dependency. ' +
    'Do not include secrets or destructive commands. Return JSON only with { summary?: string, steps: string[] }.';

  return runAssist({
    title: 'silvan:verify-recovery',
    kind: 'verification',
    system,
    input,
    task: 'verificationSummary',
    config: options.config,
    repoRoot: options.repoRoot,
    ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
    ...(options.bus ? { bus: options.bus } : {}),
    ...(options.context ? { context: options.context } : {}),
  });
}
