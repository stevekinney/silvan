import { describe, expect, it } from 'bun:test';

import {
  renderFirstRunWelcome,
  renderQuickstartChecks,
  renderWorkflowOverview,
} from './quickstart-output';

describe('quickstart output helpers', () => {
  it('renders the first run welcome message', () => {
    const output = renderFirstRunWelcome();
    expect(output).toContain('Welcome to Silvan');
    expect(output).toContain('silvan quickstart');
  });

  it('renders quickstart checks', () => {
    const output = renderQuickstartChecks(
      [
        { label: 'Git repository', status: 'ok', detail: 'Detected' },
        { label: 'GITHUB_TOKEN', status: 'warn', detail: 'Missing' },
      ],
      { title: 'Step 1: Environment check' },
    );
    expect(output).toContain('Step 1: Environment check');
    expect(output).toContain('Git repository');
    expect(output).toContain('GITHUB_TOKEN');
  });

  it('renders workflow overview', () => {
    const output = renderWorkflowOverview();
    expect(output).toContain('Workflow');
    expect(output).toContain('Task -> Plan -> Implement -> Verify -> PR -> Review');
  });
});
