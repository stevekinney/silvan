import { normalizeError } from '../core/errors';
import type { EventBus } from '../events/bus';
import { createEnvelope } from '../events/emit';
import type { CliResult, JsonError } from '../events/schema';

export type JsonOutputOptions = {
  command: string;
  data?: unknown;
  nextSteps?: string[];
  error?: JsonError;
  success?: boolean;
  runId?: string;
  repoRoot?: string;
  bus?: EventBus;
};

type AssistantSuggestion = {
  summary?: string;
  steps?: string[];
};

export function formatCommandKey(value: string): string {
  return value.trim().replace(/\s+/g, '.');
}

export function buildJsonError(
  error: unknown,
  options?: { assistant?: AssistantSuggestion | null },
): JsonError {
  const normalized = normalizeError(error);
  const details: Record<string, unknown> = {
    ...(normalized.details ?? {}),
  };
  if (normalized.runId) {
    details['runId'] = normalized.runId;
  }
  if (normalized.auditLogPath) {
    details['auditLogPath'] = normalized.auditLogPath;
  }

  const assistant = options?.assistant;
  if (assistant?.summary || assistant?.steps?.length) {
    details['assistant'] = {
      ...(assistant.summary ? { summary: assistant.summary } : {}),
      ...(assistant.steps?.length ? { steps: assistant.steps } : {}),
    };
  }

  const suggestions = [
    ...(normalized.nextSteps ?? []),
    ...(assistant?.steps ?? []),
  ].filter((step, index, arr) => arr.indexOf(step) === index);

  return {
    code: normalized.code,
    message: normalized.userMessage,
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
  };
}

export async function emitJsonResult(options: JsonOutputOptions): Promise<void> {
  const payload: CliResult = {
    command: formatCommandKey(options.command),
    success: options.success ?? !options.error,
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.nextSteps ? { nextSteps: options.nextSteps } : {}),
    ...(options.error ? { error: options.error } : {}),
  };

  const envelope = createEnvelope({
    type: 'cli.result',
    source: 'cli',
    level: payload.success ? 'info' : 'error',
    context: {
      runId: options.runId ?? crypto.randomUUID(),
      repoRoot: options.repoRoot ?? process.cwd(),
      mode: 'json',
    },
    payload,
  });

  if (options.bus) {
    await options.bus.emit(envelope);
    return;
  }

  if (
    process.env['SILVAN_QUIET'] &&
    envelope.level !== 'warn' &&
    envelope.level !== 'error'
  ) {
    return;
  }

  console.log(JSON.stringify(envelope));
}

export async function emitJsonSuccess(options: {
  command: string;
  data?: unknown;
  nextSteps?: string[];
  runId?: string;
  repoRoot?: string;
  bus?: EventBus;
}): Promise<void> {
  await emitJsonResult({ ...options, success: true });
}

export async function emitJsonError(options: {
  command: string;
  error: unknown;
  assistant?: AssistantSuggestion | null;
  runId?: string;
  repoRoot?: string;
  bus?: EventBus;
}): Promise<void> {
  const assistantOption =
    options.assistant !== undefined ? { assistant: options.assistant } : undefined;
  await emitJsonResult({
    command: options.command,
    error: buildJsonError(options.error, assistantOption),
    success: false,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
    ...(options.bus ? { bus: options.bus } : {}),
  });
}
