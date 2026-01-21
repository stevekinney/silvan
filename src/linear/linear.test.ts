import type { LinearClient } from '@linear/sdk';
import { describe, expect, it } from 'bun:test';

import { fetchLinearTicket, moveLinearTicket } from './linear';

function createLinearClientStub(options: { issue?: unknown }): LinearClient {
  return {
    issue: async () => options.issue ?? null,
  } as unknown as LinearClient;
}

describe('fetchLinearTicket', () => {
  it('maps Linear issue fields', async () => {
    const issue = {
      id: 'id-1',
      identifier: 'ENG-1',
      title: 'Test',
      description: 'Details',
      url: 'https://linear.app/issue/ENG-1',
      state: Promise.resolve({ name: 'In Progress' }),
      team: Promise.resolve({ key: 'ENG' }),
      assignee: Promise.resolve({ name: 'Dev' }),
      labels: async () => ({ nodes: [{ name: 'bug' }, { name: 'frontend' }] }),
    };
    const client = createLinearClientStub({ issue });
    const ticket = await fetchLinearTicket('ENG-1', undefined, client);
    expect(ticket.identifier).toBe('ENG-1');
    expect(ticket.labels).toEqual(['bug', 'frontend']);
    expect(ticket.assignee).toBe('Dev');
  });

  it('throws when ticket is missing', async () => {
    const client = createLinearClientStub({ issue: null });
    return expect(fetchLinearTicket('ENG-404', undefined, client)).rejects.toThrow(
      'Linear ticket not found',
    );
  });
});

describe('moveLinearTicket', () => {
  it('moves a ticket to the matching state', async () => {
    const updates: Array<{ stateId: string }> = [];
    const issue = {
      id: 'id-2',
      identifier: 'ENG-2',
      team: Promise.resolve({
        states: async () => ({ nodes: [{ id: 's1', name: 'Done' }] }),
      }),
      update: async (payload: { stateId: string }) => {
        updates.push(payload);
      },
    };
    const client = createLinearClientStub({ issue });
    await moveLinearTicket('ENG-2', 'done', undefined, client);
    expect(updates).toEqual([{ stateId: 's1' }]);
  });

  it('throws when the team is missing', async () => {
    const issue = {
      id: 'id-3',
      identifier: 'ENG-3',
      team: Promise.resolve(null),
      update: async () => {},
    };
    const client = createLinearClientStub({ issue });
    return expect(moveLinearTicket('ENG-3', 'done', undefined, client)).rejects.toThrow(
      'Linear ticket team not found',
    );
  });

  it('throws when the state is missing', async () => {
    const issue = {
      id: 'id-4',
      identifier: 'ENG-4',
      team: Promise.resolve({
        states: async () => ({ nodes: [{ id: 's1', name: 'Backlog' }] }),
      }),
      update: async () => {},
    };
    const client = createLinearClientStub({ issue });
    return expect(moveLinearTicket('ENG-4', 'done', undefined, client)).rejects.toThrow(
      'Linear state not found',
    );
  });
});
