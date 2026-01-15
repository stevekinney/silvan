import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { runGit } from '../git/exec';

export type TicketMatch = {
  ticketId: string;
  teamKey: string;
  ticketNumber: number;
  source: 'branch' | 'commit';
};

const ticketPattern = /\b([A-Z]{2,10})-(\d+)\b/;

export function extractTicketFromBranch(branch: string): TicketMatch | null {
  const match = branch.match(ticketPattern);
  if (!match) {
    return null;
  }
  const teamKey = match[1]!;
  const numberStr = match[2]!;
  return {
    ticketId: `${teamKey}-${numberStr}`,
    teamKey,
    ticketNumber: Number(numberStr),
    source: 'branch',
  };
}

export async function inferTicketFromRepo(options: {
  repoRoot: string;
  bus?: EventBus;
  context: EmitContext;
}): Promise<TicketMatch | null> {
  const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });
  const branch = branchResult.stdout.trim();
  const fromBranch = extractTicketFromBranch(branch);
  if (fromBranch) {
    return fromBranch;
  }

  const logResult = await runGit(['log', '--oneline', '-10', '--format=%s'], {
    cwd: options.repoRoot,
    bus: options.bus,
    context: options.context,
  });
  for (const line of logResult.stdout.split('\n')) {
    const match = line.match(ticketPattern);
    if (match) {
      const teamKey = match[1]!;
      const numberStr = match[2]!;
      return {
        ticketId: `${teamKey}-${numberStr}`,
        teamKey,
        ticketNumber: Number(numberStr),
        source: 'commit',
      };
    }
  }

  return null;
}
