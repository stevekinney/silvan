import type { Octokit } from 'octokit';

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
  octokit?: Octokit;
  bus?: EventBus;
  context: EmitContext;
}): Promise<PrWithHead> {
  const octokit = options.octokit ?? createOctokit(options.token);
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
  octokit?: Octokit;
  bus?: EventBus;
  context: EmitContext;
}): Promise<CiResult> {
  const octokit = options.octokit ?? createOctokit(options.token);
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
  octokit?: Octokit;
  pollIntervalMs: number;
  timeoutMs: number;
  onHeartbeat?: () => Promise<void>;
  sleep?: (durationMs: number) => Promise<void>;
  bus?: EventBus;
  context: EmitContext;
}): Promise<CiResult> {
  const start = Date.now();
  const warnAtMs = Math.floor(options.timeoutMs * 0.8);
  let warned = false;
  const octokit = options.octokit ?? createOctokit(options.token);
  let { pr, headSha } = await findPrForBranch({
    ...options,
    octokit,
  });

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
    const latest = await findPrForBranch({
      ...options,
      octokit,
    });
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
      octokit,
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

    if (!warned && options.timeoutMs > 0 && Date.now() - start >= warnAtMs) {
      warned = true;
      const elapsed = Date.now() - start;
      const remaining = Math.max(options.timeoutMs - elapsed, 0);
      const message = `Approaching CI timeout (${formatDuration(elapsed)} elapsed, ${formatDuration(
        remaining,
      )} remaining)`;
      if (options.bus) {
        await options.bus.emit(
          createEnvelope({
            type: 'log.message',
            source: 'github',
            level: 'warn',
            context: options.context,
            message,
            payload: { message },
          }),
        );
      } else {
        console.warn(message);
      }
    }
    const sleep = options.sleep ?? Bun.sleep;
    await sleep(options.pollIntervalMs);
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

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
