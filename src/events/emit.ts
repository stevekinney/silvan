import { hashString } from '../utils/hash';
import type {
  ErrorKind,
  EventEnvelope,
  EventLevel,
  EventMode,
  EventSource,
} from './schema';

const schemaVersion = '1.0.0' as const;
const schemaName = 'com.silvan.events' as const;

export type EmitContext = {
  runId: string;
  repoRoot: string;
  mode?: EventMode;
  worktreePath?: string;
  prId?: string;
  taskId?: string;
};

export function createEnvelope<TType extends string, TPayload>(options: {
  type: TType;
  payload: TPayload;
  level: EventLevel;
  source: EventSource;
  message?: string;
  context: EmitContext;
  error?: EventEnvelope<TType, TPayload>['error'];
  span?: EventEnvelope<TType, TPayload>['span'];
}): EventEnvelope<TType, TPayload> {
  const now = new Date().toISOString();
  const repoId = hashString(options.context.repoRoot);
  const worktreeId = options.context.worktreePath
    ? hashString(options.context.worktreePath)
    : undefined;

  const envelope: EventEnvelope<TType, TPayload> = {
    schema: schemaName,
    version: schemaVersion,
    id: crypto.randomUUID(),
    ts: now,
    level: options.level,
    source: options.source,
    runId: options.context.runId,
    repoId,
    type: options.type,
    payload: options.payload,
  };

  if (worktreeId) {
    envelope.worktreeId = worktreeId;
  }
  if (options.context.prId) {
    envelope.prId = options.context.prId;
  }
  if (options.context.taskId) {
    envelope.taskId = options.context.taskId;
  }
  if (options.context.mode) {
    envelope.mode = options.context.mode;
  }
  if (options.message) {
    envelope.message = options.message;
  }
  if (options.error) {
    envelope.error = options.error;
  }
  if (options.span) {
    envelope.span = options.span;
  }

  return envelope;
}

export function toEventError(error: unknown): EventEnvelope<string, unknown>['error'] {
  if (error instanceof Error) {
    const err = error as Error & {
      code?: string;
      cause?: unknown;
      kind?: unknown;
      details?: Record<string, unknown>;
      userMessage?: string;
    };
    const message =
      typeof err.userMessage === 'string' && err.userMessage.length > 0
        ? err.userMessage
        : err.message;
    const details =
      err.userMessage && err.userMessage !== err.message
        ? { ...(err.details ?? {}), internalMessage: err.message }
        : err.details;
    const kind = isErrorKind(err.kind) ? err.kind : undefined;
    return {
      name: err.name,
      message,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(err.code ? { code: String(err.code) } : {}),
      ...(kind ? { kind } : {}),
      ...(details ? { details } : {}),
      ...(err.cause ? { cause: toEventError(err.cause) } : {}),
    };
  }

  if (typeof error === 'string') {
    return { name: 'Error', message: error };
  }

  return { name: 'UnknownError', message: 'Unknown error' };
}

function isErrorKind(value: unknown): value is ErrorKind {
  return (
    value === 'expected' ||
    value === 'validation' ||
    value === 'auth' ||
    value === 'not_found' ||
    value === 'conflict' ||
    value === 'canceled' ||
    value === 'internal'
  );
}
