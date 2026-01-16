import { describe, expect, it } from 'bun:test';

import type { ArtifactEntry } from '../state/artifacts';
import { deriveRunConvergence, type RunConvergenceStatus } from './convergence';

function artifact(stepId: string, name = 'entry'): ArtifactEntry {
  return {
    stepId,
    name,
    path: `/tmp/${stepId}/${name}.json`,
    digest: 'digest',
    updatedAt: new Date().toISOString(),
    kind: 'json',
  };
}

function expectStatus(
  status: RunConvergenceStatus,
  state: Record<string, unknown>,
  artifacts: ArtifactEntry[] = [],
): void {
  const result = deriveRunConvergence(state, artifacts);
  expect(result.status).toBe(status);
}

describe('deriveRunConvergence', () => {
  it('returns running when a step is active', () => {
    expectStatus('running', {
      run: { status: 'running' },
      steps: { 'ci.wait': { status: 'running' } },
    });
  });

  it('returns waiting_for_user when local gate blocks', () => {
    expectStatus('waiting_for_user', {
      run: { status: 'running' },
      localGateSummary: { ok: false, blockers: 2 },
    });
  });

  it('ignores local gate blockers when overrides exist', () => {
    const result = deriveRunConvergence(
      {
        run: { status: 'running' },
        localGateSummary: { ok: false, blockers: 1 },
      },
      [artifact('overrides')],
    );
    expect(result.status).not.toBe('waiting_for_user');
  });

  it('returns waiting_for_ci when CI is pending', () => {
    expectStatus('waiting_for_ci', {
      run: { status: 'running' },
      summary: { ci: 'pending' },
    });
  });

  it('returns waiting_for_review when unresolved comments remain', () => {
    expectStatus('waiting_for_review', {
      run: { status: 'running' },
      summary: { unresolvedReviewCount: 3 },
    });
  });

  it('returns blocked when summary indicates blocking reason', () => {
    expectStatus('blocked', {
      run: { status: 'running' },
      summary: { blockedReason: 'Local gate failed' },
    });
  });

  it('returns failed when run status failed', () => {
    expectStatus('failed', {
      run: { status: 'failed' },
    });
  });

  it('returns converged when run status success', () => {
    expectStatus('converged', {
      run: { status: 'success' },
    });
  });

  it('returns aborted when abort artifact exists', () => {
    expectStatus('aborted', { run: { status: 'running' } }, [artifact('run.abort')]);
  });
});
