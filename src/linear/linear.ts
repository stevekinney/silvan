import { LinearClient } from '@linear/sdk';

import { SilvanError } from '../core/errors';
import { readEnvValue } from '../utils/env';

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

function getLinearClient(apiKey?: string, client?: LinearClient): LinearClient {
  if (client) return client;
  const resolved = apiKey ?? readEnvValue('LINEAR_API_KEY');
  if (!resolved) {
    throw new SilvanError({
      code: 'auth.linear.missing_token',
      message: 'Missing Linear token (configure linear.token or set LINEAR_API_KEY).',
      userMessage: 'Missing Linear token.',
      kind: 'auth',
      nextSteps: [
        'Set LINEAR_API_KEY in your environment.',
        'Or configure linear.token in silvan.config.ts.',
      ],
    });
  }
  return new LinearClient({ apiKey: resolved });
}

export async function fetchLinearTicket(
  idOrKey: string,
  token?: string,
  client?: LinearClient,
): Promise<LinearTicket> {
  const resolvedClient = getLinearClient(token, client);
  const issue = await resolvedClient.issue(idOrKey);
  if (!issue) {
    throw new SilvanError({
      code: 'linear.ticket.not_found',
      message: `Linear ticket not found: ${idOrKey}`,
      userMessage: `Linear ticket not found: ${idOrKey}.`,
      kind: 'not_found',
    });
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
  client?: LinearClient,
): Promise<void> {
  const resolvedClient = getLinearClient(token, client);
  const issue = await resolvedClient.issue(idOrKey);
  if (!issue) {
    throw new SilvanError({
      code: 'linear.ticket.not_found',
      message: `Linear ticket not found: ${idOrKey}`,
      userMessage: `Linear ticket not found: ${idOrKey}.`,
      kind: 'not_found',
    });
  }

  const team = await issue.team;
  if (!team) {
    throw new SilvanError({
      code: 'linear.team.not_found',
      message: 'Linear ticket team not found',
      userMessage: 'Linear ticket team not found.',
      kind: 'not_found',
    });
  }

  const states = await team.states();
  const match = states.nodes.find(
    (state) => state.name.toLowerCase() === stateName.toLowerCase(),
  );
  if (!match) {
    throw new SilvanError({
      code: 'linear.state.not_found',
      message: `Linear state not found: ${stateName}`,
      userMessage: `Linear state not found: ${stateName}.`,
      kind: 'not_found',
    });
  }

  await issue.update({ stateId: match.id });
}
