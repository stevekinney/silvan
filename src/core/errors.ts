export type ErrorKind =
  | 'expected'
  | 'validation'
  | 'auth'
  | 'not_found'
  | 'conflict'
  | 'canceled'
  | 'internal';

export type ErrorContext = {
  runId?: string;
  auditLogPath?: string;
};

export type SilvanErrorOptions = {
  code: string;
  message: string;
  userMessage?: string;
  kind?: ErrorKind;
  exitCode?: number;
  details?: Record<string, unknown>;
  nextSteps?: string[];
  cause?: unknown;
  context?: ErrorContext;
};

export class SilvanError extends Error {
  code: string;
  kind: ErrorKind;
  userMessage: string;
  exitCode: number;
  details?: Record<string, unknown>;
  nextSteps?: string[];
  override cause?: unknown;
  runId?: string;
  auditLogPath?: string;

  constructor(options: SilvanErrorOptions) {
    super(options.message);
    this.name = 'SilvanError';
    this.code = options.code;
    this.kind = options.kind ?? 'expected';
    this.userMessage = options.userMessage ?? options.message;
    this.exitCode = options.exitCode ?? (this.kind === 'canceled' ? 130 : 1);
    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.nextSteps !== undefined) {
      this.nextSteps = options.nextSteps;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options.context?.runId) {
      this.runId = options.context.runId;
    }
    if (options.context?.auditLogPath) {
      this.auditLogPath = options.context.auditLogPath;
    }
  }
}

export class RunCanceledError extends Error {
  constructor() {
    super('Run canceled');
    this.name = 'RunCanceledError';
  }
}

export function normalizeError(error: unknown, context?: ErrorContext): SilvanError {
  if (error instanceof SilvanError) {
    return attachContext(error, context);
  }

  if (error instanceof RunCanceledError) {
    return new SilvanError({
      code: 'run_canceled',
      message: error.message,
      userMessage: 'Canceled.',
      kind: 'canceled',
      exitCode: 130,
      cause: error,
      ...(context ? { context } : {}),
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new SilvanError({
    code: 'unexpected_error',
    message,
    userMessage: message || 'Unexpected error.',
    kind: 'internal',
    exitCode: 1,
    cause: error,
    ...(context ? { context } : {}),
  });
}

function attachContext(error: SilvanError, context?: ErrorContext): SilvanError {
  if (!context) return error;
  if (!error.runId && context.runId) {
    error.runId = context.runId;
  }
  if (!error.auditLogPath && context.auditLogPath) {
    error.auditLogPath = context.auditLogPath;
  }
  return error;
}
