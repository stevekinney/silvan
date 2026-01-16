import { fetchLinearTicket, type LinearTicket } from '../../linear/linear';
import type { Task } from '../types';
import {
  extractAcceptanceCriteria,
  extractChecklistItems,
  normalizeCriteria,
} from '../utils';

export async function fetchLinearTask(id: string, token?: string): Promise<Task> {
  const ticket = await fetchLinearTicket(id, token);
  return linearTicketToTask(ticket);
}

export function linearTicketToTask(ticket: LinearTicket): Task {
  const criteria = normalizeCriteria([
    ...extractAcceptanceCriteria(ticket.description ?? ''),
    ...extractChecklistItems(ticket.description ?? ''),
  ]);
  const state = ticket.state ?? ticket.status ?? undefined;
  return {
    id: ticket.identifier,
    provider: 'linear',
    title: ticket.title,
    description: ticket.description ?? '',
    acceptanceCriteria: criteria,
    url: ticket.url,
    labels: ticket.labels ?? [],
    ...(ticket.assignee ? { assignee: ticket.assignee } : {}),
    ...(state ? { state } : {}),
    metadata: {
      teamKey: ticket.teamKey,
    },
  };
}
