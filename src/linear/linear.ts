import { LinearClient } from '@linear/sdk';

export type LinearTicket = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state?: string | null;
  teamKey?: string | null;
};

function getLinearClient(): LinearClient {
  const apiKey = Bun.env['LINEAR_API_KEY'];
  if (!apiKey) {
    throw new Error('Missing LINEAR_API_KEY');
  }
  return new LinearClient({ apiKey });
}

export async function fetchLinearTicket(idOrKey: string): Promise<LinearTicket> {
  const client = getLinearClient();
  const issue = await client.issue(idOrKey);
  if (!issue) {
    throw new Error(`Linear ticket not found: ${idOrKey}`);
  }

  const state = await issue.state;
  const team = await issue.team;

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    url: issue.url,
    state: state?.name ?? null,
    teamKey: team?.key ?? null,
  };
}

export async function moveLinearTicket(
  idOrKey: string,
  stateName: string,
): Promise<void> {
  const client = getLinearClient();
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
