import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope, toEventError } from '../events/emit';
import type { GitHubError, PrIdent } from '../events/schema';

type ErrorWithStatus = { status?: number; message?: string };

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as ErrorWithStatus).status;
  return typeof status === 'number' ? status : undefined;
}

export async function emitGitHubError(options: {
  bus?: EventBus;
  context: EmitContext;
  operation: GitHubError['operation'];
  error: unknown;
  pr?: PrIdent;
  details?: string;
}): Promise<void> {
  if (!options.bus) return;

  const status = getStatus(options.error);

  await options.bus.emit(
    createEnvelope({
      type: 'github.error',
      source: 'github',
      level: 'error',
      context: {
        ...options.context,
        ...(options.pr
          ? {
              prId: `${options.pr.owner}/${options.pr.repo}#${options.pr.number}`,
            }
          : {}),
      },
      payload: {
        operation: options.operation,
        ...(options.pr ? { pr: options.pr } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(options.details ? { details: options.details } : {}),
      },
      error: toEventError(options.error),
    }),
  );
}
