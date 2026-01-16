import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import type { CiState, CiStatus, PrIdent } from '../events/schema';
import { createOctokit } from './client';
import { emitGitHubError } from './errors';

export type CiResult = CiStatus;

type PrWithHead = { pr: PrIdent; headSha: string };

async function findPrForBranch(options: {
  owner: string;
  repo: string;
  headBranch: string;
  token?: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<PrWithHead> {
  const octokit = createOctokit(options.token);
  let response;
  try {
    response = await octokit.rest.pulls.list({
      owner: options.owner,
      repo: options.repo,
      head: `${options.owner}:${options.headBranch}`,
      state: 'open',
    });
  } catch (error) {
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'find_pr',
      error,
      details: `Failed to find PR for ${options.headBranch}`,
    });
    throw error;
  }

  if (response.data.length === 0) {
    const error = new Error('No open PR found for branch');
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'find_pr',
      error,
      details: `No open PR found for ${options.headBranch}`,
    });
    throw error;
  }

  const pr = response.data[0]!;
  return {
    pr: {
      owner: options.owner,
      repo: options.repo,
      number: pr.number,
      url: pr.html_url ?? undefined,
    },
    headSha: pr.head.sha,
  };
}

function normalizeCiState(conclusions: Array<string | null | undefined>): CiState {
  if (
    conclusions.some((c) => c === 'failure' || c === 'cancelled' || c === 'timed_out')
  ) {
    return 'failing';
  }
  if (conclusions.some((c) => c === null || c === undefined)) {
    return 'pending';
  }
  if (conclusions.every((c) => c === 'success' || c === 'skipped' || c === 'neutral')) {
    return 'passing';
  }
  return 'unknown';
}

export async function getCiStatus(options: {
  owner: string;
  repo: string;
  headSha: string;
  pr: PrIdent;
  token?: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<CiResult> {
  const octokit = createOctokit(options.token);
  let checks;
  try {
    checks = await octokit.rest.checks.listForRef({
      owner: options.owner,
      repo: options.repo,
      ref: options.headSha,
    });
  } catch (error) {
    await emitGitHubError({
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
      operation: 'fetch_checks',
      error,
      pr: options.pr,
      details: 'Failed to fetch CI checks',
    });
    throw error;
  }

  const checkRuns = checks.data.check_runs;
  const state = normalizeCiState(checkRuns.map((run) => run.conclusion));
  const summary = `${checkRuns.length} checks`;

  return {
    pr: options.pr,
    state,
    summary,
    checks: checkRuns.map((run) => {
      const state =
        run.status === 'completed'
          ? 'completed'
          : run.status === 'in_progress'
            ? 'in_progress'
            : 'queued';
      const check: NonNullable<CiStatus['checks']>[number] = {
        name: run.name,
        state,
        ...(run.conclusion ? { conclusion: run.conclusion } : {}),
        ...(run.html_url ? { url: run.html_url } : {}),
      };
      return check;
    }),
  };
}

export async function waitForCi(options: {
  owner: string;
  repo: string;
  headBranch: string;
  token?: string;
  pollIntervalMs: number;
  timeoutMs: number;
  onHeartbeat?: () => Promise<void>;
  bus?: EventBus;
  context: EmitContext;
}): Promise<CiResult> {
  const start = Date.now();
  let { pr, headSha } = await findPrForBranch(options);

  if (options.bus) {
    await options.bus.emit(
      createEnvelope({
        type: 'ci.wait_started',
        source: 'github',
        level: 'info',
        context: { ...options.context, prId: `${pr.owner}/${pr.repo}#${pr.number}` },
        payload: { pr, pollIntervalMs: options.pollIntervalMs },
      }),
    );
  }

  while (Date.now() - start < options.timeoutMs) {
    const latest = await findPrForBranch(options);
    if (latest.headSha !== headSha) {
      headSha = latest.headSha;
      pr = latest.pr;
    }
    const payload = await getCiStatus({
      owner: options.owner,
      repo: options.repo,
      headSha,
      pr,
      ...(options.token ? { token: options.token } : {}),
      ...(options.bus ? { bus: options.bus } : {}),
      context: options.context,
    });

    if (options.bus) {
      await options.bus.emit(
        createEnvelope({
          type: 'ci.status',
          source: 'github',
          level: 'info',
          context: { ...options.context, prId: `${pr.owner}/${pr.repo}#${pr.number}` },
          payload,
        }),
      );
    }

    if (payload.state === 'passing' || payload.state === 'failing') {
      const durationMs = Date.now() - start;
      if (options.bus) {
        await options.bus.emit(
          createEnvelope({
            type: 'ci.wait_finished',
            source: 'github',
            level: 'info',
            context: { ...options.context, prId: `${pr.owner}/${pr.repo}#${pr.number}` },
            payload: { pr, final: payload, durationMs },
          }),
        );
      }

      return payload;
    }

    if (options.onHeartbeat) {
      await options.onHeartbeat();
    }
    await Bun.sleep(options.pollIntervalMs);
  }

  const timeoutError = new Error('Timed out waiting for CI');
  await emitGitHubError({
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context,
    operation: 'fetch_checks',
    error: timeoutError,
    pr,
    details: 'Timed out waiting for CI',
  });
  throw timeoutError;
}
