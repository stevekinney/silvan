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

export function formatCommandKey(value: string): string {
  return value.trim().replace(/\s+/g, '.');
}

export function buildJsonError(error: unknown): JsonError {
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

  return {
    code: normalized.code,
    message: normalized.userMessage,
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(normalized.nextSteps ? { suggestions: normalized.nextSteps } : {}),
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
  runId?: string;
  repoRoot?: string;
  bus?: EventBus;
}): Promise<void> {
  await emitJsonResult({
    command: options.command,
    error: buildJsonError(options.error),
    success: false,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
    ...(options.bus ? { bus: options.bus } : {}),
  });
}
