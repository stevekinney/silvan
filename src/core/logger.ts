import type { EventBus } from '../events/bus';
import { createEnvelope, type EmitContext, toEventError } from '../events/emit';
import type { EventLevel, EventSource } from '../events/schema';

export type Logger = {
  debug: (message: string, details?: Record<string, unknown>) => Promise<void>;
  info: (message: string, details?: Record<string, unknown>) => Promise<void>;
  warn: (message: string, details?: Record<string, unknown>) => Promise<void>;
  error: (
    message: string,
    options?: { details?: Record<string, unknown>; error?: unknown },
  ) => Promise<void>;
  withSpan: <T>(
    name: string,
    fn: () => Promise<T>,
    details?: Record<string, unknown>,
  ) => Promise<T>;
};

export function createLogger(options: {
  bus: EventBus;
  context: EmitContext;
  source: EventSource;
}): Logger {
  const { bus, context, source } = options;

  const emit = async (
    level: EventLevel,
    message: string,
    options?: {
      details?: Record<string, unknown>;
      error?: unknown;
      span?: { spanId: string; startTs?: string; endTs?: string; durationMs?: number };
    },
  ): Promise<void> => {
    await bus.emit(
      createEnvelope({
        type: 'log.message',
        source,
        level,
        context,
        message,
        payload: {
          message,
          ...(options?.details ? { details: options.details } : {}),
        },
        ...(options?.error ? { error: toEventError(options.error) } : {}),
        ...(options?.span ? { span: options.span } : {}),
      }),
    );
  };

  const withSpan = async <T>(
    name: string,
    fn: () => Promise<T>,
    details?: Record<string, unknown>,
  ): Promise<T> => {
    const spanId = crypto.randomUUID();
    const start = Date.now();
    const startTs = new Date(start).toISOString();
    await emit('debug', `${name} started`, {
      ...(details === undefined ? {} : { details }),
      span: { spanId, startTs },
    });
    try {
      const result = await fn();
      const end = Date.now();
      await emit('debug', `${name} finished`, {
        ...(details === undefined ? {} : { details }),
        span: {
          spanId,
          startTs,
          endTs: new Date(end).toISOString(),
          durationMs: end - start,
        },
      });
      return result;
    } catch (error) {
      const end = Date.now();
      await emit('error', `${name} failed`, {
        ...(details === undefined ? {} : { details }),
        error,
        span: {
          spanId,
          startTs,
          endTs: new Date(end).toISOString(),
          durationMs: end - start,
        },
      });
      throw error;
    }
  };

  return {
    debug: (message, details) =>
      emit('debug', message, details === undefined ? undefined : { details }),
    info: (message, details) =>
      emit('info', message, details === undefined ? undefined : { details }),
    warn: (message, details) =>
      emit('warn', message, details === undefined ? undefined : { details }),
    error: (message, options) => emit('error', message, options),
    withSpan,
  };
}
