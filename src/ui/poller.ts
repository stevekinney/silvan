import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { createEnvelope } from '../events/emit';
import { getCiStatus } from '../github/ci';
import { listOpenPullRequests } from '../github/pr';
import { fetchUnresolvedReviewComments } from '../github/review';

export function startPrSnapshotPoller(options: {
  owner: string;
  repo: string;
  bus: EventBus;
  context: EmitContext;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  const interval = options.intervalMs ?? 30000;

  const tick = async () => {
    if (stopped) return;
    const prs = await listOpenPullRequests({
      owner: options.owner,
      repo: options.repo,
      bus: options.bus,
      context: options.context,
    });

    const snapshots = [];
    for (const pr of prs) {
      const ci = await getCiStatus({
        owner: options.owner,
        repo: options.repo,
        headSha: pr.headSha,
        pr: pr.pr,
        bus: options.bus,
        context: options.context,
      });
      const review = await fetchUnresolvedReviewComments({
        owner: options.owner,
        repo: options.repo,
        headBranch: pr.headBranch,
        context: options.context,
      });
      snapshots.push({
        id: `${pr.pr.owner}/${pr.pr.repo}#${pr.pr.number}`,
        title: pr.title,
        ...(pr.pr.url ? { url: pr.pr.url } : {}),
        headBranch: pr.headBranch,
        baseBranch: pr.baseBranch,
        ci: ci.state,
        unresolvedReviewCount: review.comments.length,
      });
    }

    await options.bus.emit(
      createEnvelope({
        type: 'github.prs_snapshot',
        source: 'github',
        level: 'info',
        context: options.context,
        payload: { prs: snapshots },
      }),
    );
  };

  const timer = setInterval(() => {
    void tick();
  }, interval);

  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
