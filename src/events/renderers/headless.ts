import type { Event } from '../schema';

export class HeadlessRenderer {
  render(event: Event): void {
    switch (event.type) {
      case 'log.message': {
        if (event.level === 'debug' && !process.env['SILVAN_DEBUG']) {
          return;
        }
        const message = event.message ?? event.payload.message;
        if (event.level === 'error') {
          console.error(message);
          return;
        }
        if (event.level === 'warn') {
          console.warn(message);
          return;
        }
        console.log(message);
        return;
      }
      case 'run.started':
        console.log(`Starting ${event.payload.command} in ${event.payload.repoRoot}`);
        return;
      case 'worktree.listed':
        console.log(`Found ${event.payload.count} worktree(s)`);
        return;
      case 'worktree.created':
        console.log(`Created worktree ${event.payload.branch} at ${event.payload.path}`);
        return;
      case 'worktree.removed':
        console.log(`Removed worktree at ${event.payload.path}`);
        return;
      case 'github.pr_opened_or_updated':
        console.log(
          `${event.payload.action} PR #${event.payload.pr.number} (${event.payload.pr.url ?? 'no url'})`,
        );
        return;
      case 'ci.status':
        console.log(`CI ${event.payload.state}: ${event.payload.summary ?? ''}`.trim());
        return;
      case 'run.finished':
        console.log(`Run ${event.payload.status} (${event.payload.durationMs}ms)`);
        return;
      default:
        if (event.message) {
          console.log(event.message);
        }
    }
  }
}
