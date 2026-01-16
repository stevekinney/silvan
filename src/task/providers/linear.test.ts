import { describe, expect, it } from 'bun:test';

import type { LinearTicket } from '../../linear/linear';
import { linearTicketToTask } from './linear';

describe('linearTicketToTask', () => {
  it('maps Linear ticket to Task', () => {
    const ticket: LinearTicket = {
      id: '1',
      identifier: 'DEP-10',
      title: 'Workspace integration',
      description: '## Acceptance Criteria\n- supports teams\n- shows UI',
      url: 'https://linear.app/example',
      state: 'In Progress',
      status: 'In Progress',
      teamKey: 'DEP',
      labels: ['integration'],
      assignee: 'Jane Doe',
    };

    const task = linearTicketToTask(ticket);
    expect(task.id).toBe('DEP-10');
    expect(task.key).toBe('DEP-10');
    expect(task.provider).toBe('linear');
    expect(task.acceptanceCriteria).toContain('supports teams');
    expect(task.labels).toContain('integration');
    expect(task.assignee).toBe('Jane Doe');
  });
});
