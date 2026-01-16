import { normalizeError, SilvanError } from '../core/errors';

export type CliErrorRenderOptions = {
  debug?: boolean;
  trace?: boolean;
};

export function renderCliError(
  error: unknown,
  options?: CliErrorRenderOptions,
): { error: SilvanError; message: string } {
  const normalized = normalizeError(error);
  const lines: string[] = [];

  lines.push(`Error: ${normalized.userMessage}`);

  if (normalized.code) {
    lines.push(`Code: ${normalized.code}`);
  }
  if (normalized.runId) {
    lines.push(`Run ID: ${normalized.runId}`);
  }
  if (normalized.auditLogPath) {
    lines.push(`Audit log: ${normalized.auditLogPath}`);
  }

  const nextSteps = normalized.nextSteps ? [...normalized.nextSteps] : [];
  if (normalized.runId) {
    const logHint = `View logs: silvan logs ${normalized.runId}`;
    if (!nextSteps.includes(logHint)) {
      nextSteps.push(logHint);
    }
  }
  if (nextSteps.length > 0) {
    lines.push('Next steps:');
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  if (options?.debug || options?.trace) {
    lines.push('');
    lines.push('Debug:');
    if (normalized.stack) {
      lines.push(normalized.stack);
    } else {
      lines.push('No stack available.');
    }
    if (options?.trace && normalized.cause) {
      lines.push('');
      lines.push(`Cause: ${formatCause(normalized.cause)}`);
    }
  }

  return { error: normalized, message: lines.join('\n') };
}

function formatCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack ?? cause.message;
  }
  return typeof cause === 'string' ? cause : JSON.stringify(cause);
}
