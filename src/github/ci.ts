import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import type { CiState, PrIdent } from '../events/schema';
import { createOctokit } from './client';

export type CiResult = {
  pr: PrIdent;
  state: CiState;
  summary?: string;
  checks: Array<{ name: string; state: string; conclusion?: string; url?: string }>;
};

async function findPrForBranch(options: {
  owner: string;
  repo: string;
  headBranch: string;
}): Promise<PrIdent> {
  const octokit = createOctokit();
  const response = await octokit.rest.pulls.list({
    owner: options.owner,
    repo: options.repo,
    head: `${options.owner}:${options.headBranch}`,
    state: 'open',
  });

  if (response.data.length === 0) {
    throw new Error('No open PR found for branch');
  }

  const pr = response.data[0]!;
  return {
    owner: options.owner,
    repo: options.repo,
    number: pr.number,
    url: pr.html_url,
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

export async function waitForCi(options: {
  owner: string;
  repo: string;
  headBranch: string;
  pollIntervalMs: number;
  timeoutMs: number;
  bus?: EventBus;
  context: EmitContext;
}): Promise<CiResult> {
  const octokit = createOctokit();
  const start = Date.now();
  const pr = await findPrForBranch(options);

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
    const checks = await octokit.rest.checks.listForRef({
      owner: options.owner,
      repo: options.repo,
      ref: options.headBranch,
    });

    const checkRuns = checks.data.check_runs;
    const state = normalizeCiState(checkRuns.map((run) => run.conclusion));
    const summary = `${checkRuns.length} checks`;

    const payload = {
      pr,
      state,
      summary,
      checks: checkRuns.map((run) => {
        const check = {
          name: run.name,
          state:
            run.status === 'completed'
              ? 'completed'
              : run.status === 'in_progress'
                ? 'in_progress'
                : 'queued',
        } as const;

        return {
          ...check,
          ...(run.conclusion ? { conclusion: run.conclusion } : {}),
          ...(run.html_url ? { url: run.html_url } : {}),
        };
      }),
    };

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

    if (state === 'passing' || state === 'failing') {
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

    await Bun.sleep(options.pollIntervalMs);
  }

  throw new Error('Timed out waiting for CI');
}
