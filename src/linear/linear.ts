import { LinearClient } from '@linear/sdk';

export type LinearTicket = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state?: string | null;
  status?: string | null;
  teamKey?: string | null;
  labels?: string[];
  assignee?: string | null;
};

function getLinearClient(apiKey?: string): LinearClient {
  const resolved = apiKey ?? Bun.env['LINEAR_API_KEY'];
  if (!resolved) {
    throw new Error(
      'Missing Linear token (configure linear.token or set LINEAR_API_KEY).',
    );
  }
  return new LinearClient({ apiKey: resolved });
}

export async function fetchLinearTicket(
  idOrKey: string,
  token?: string,
): Promise<LinearTicket> {
  const client = getLinearClient(token);
  const issue = await client.issue(idOrKey);
  if (!issue) {
    throw new Error(`Linear ticket not found: ${idOrKey}`);
  }

  const state = await issue.state;
  const team = await issue.team;
  const assignee = await issue.assignee;
  const labels = await issue.labels();
  const labelNames = labels?.nodes?.map((label) => label.name) ?? [];

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    url: issue.url,
    state: state?.name ?? null,
    status: state?.name ?? null,
    teamKey: team?.key ?? null,
    labels: labelNames,
    assignee: assignee?.name ?? null,
  };
}

export async function moveLinearTicket(
  idOrKey: string,
  stateName: string,
  token?: string,
): Promise<void> {
  const client = getLinearClient(token);
  const issue = await client.issue(idOrKey);
  if (!issue) {
    throw new Error(`Linear ticket not found: ${idOrKey}`);
  }

  const team = await issue.team;
  if (!team) {
    throw new Error('Linear ticket team not found');
  }

  const states = await team.states();
  const match = states.nodes.find(
    (state) => state.name.toLowerCase() === stateName.toLowerCase(),
  );
  if (!match) {
    throw new Error(`Linear state not found: ${stateName}`);
  }

  await issue.update({ stateId: match.id });
}
