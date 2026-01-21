import {
  colors,
  divider,
  formatStatusLabel,
  padLabel,
  renderSectionHeader,
} from './output';

const LINE_WIDTH = 60;
const CHECK_LABEL_WIDTH = 24;

export type QuickstartCheck = {
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
};

export type QuickstartRunSummary = {
  runId: string;
  status: string;
  title: string;
};

export function renderFirstRunWelcome(): string {
  const lines: string[] = [];
  lines.push(
    renderSectionHeader('Welcome to Silvan', { width: LINE_WIDTH, kind: 'major' }),
  );
  lines.push('AI-driven development workflows for your codebase');
  lines.push('');
  lines.push('Get started:');
  lines.push('  silvan init          Configure for this repository');
  lines.push('  silvan quickstart    Guided setup + sample plan');
  lines.push('  silvan doctor        Check your environment');
  lines.push('');
  lines.push('Learn more:');
  lines.push('  silvan help          View help topics');
  lines.push('  silvan --help        Command reference');
  lines.push('');
  lines.push(divider('minor', LINE_WIDTH));
  lines.push("Tip: Run 'silvan quickstart' for a guided introduction");
  return lines.join('\n');
}

export function renderReturningSummary(options: {
  repo?: string;
  runs?: QuickstartRunSummary[];
}): string {
  const lines: string[] = [];
  lines.push(renderSectionHeader('Silvan', { width: LINE_WIDTH, kind: 'minor' }));
  lines.push('AI-driven development workflows');
  lines.push('');
  lines.push('Quick commands:');
  lines.push('  silvan task start "description"    Start a new task');
  lines.push('  silvan run list                    View all runs');
  lines.push('  silvan ui                          Open dashboard');

  if (options.repo) {
    lines.push('');
    lines.push(`Current repository: ${options.repo}`);
  }

  const runs = options.runs ?? [];
  if (runs.length > 0) {
    lines.push('');
    lines.push(`Active runs: ${runs.length}`);
    for (const run of runs) {
      const id = colors.dim(run.runId.slice(0, 8));
      lines.push(`  ${id} ${formatStatusLabel(run.status)} ${run.title}`);
    }
  }

  lines.push('');
  lines.push('silvan --help for all commands');
  return lines.join('\n');
}

export function renderQuickstartHeader(): string {
  const lines: string[] = [];
  lines.push(
    renderSectionHeader('Silvan Quickstart', { width: LINE_WIDTH, kind: 'major' }),
  );
  lines.push("Let's get you set up and running your first task!");
  return lines.join('\n');
}

export function renderQuickstartStep(title: string): string {
  return renderSectionHeader(title, { width: LINE_WIDTH, kind: 'minor' });
}

export function renderQuickstartChecks(
  checks: QuickstartCheck[],
  options?: { title?: string },
): string {
  const lines: string[] = [];
  if (options?.title) {
    lines.push(renderQuickstartStep(options.title));
  }
  for (const check of checks) {
    lines.push(
      `${formatCheckStatus(check.status)} ${padLabel(check.label, CHECK_LABEL_WIDTH)} ${check.detail}`,
    );
  }
  return lines.join('\n');
}

export function renderQuickstartMissingRequirements(options: {
  providerLabel: string;
  envVar: string;
  url: string;
}): string {
  const lines: string[] = [];
  lines.push(
    renderSectionHeader('Missing required configuration', {
      width: LINE_WIDTH,
      kind: 'minor',
    }),
  );
  lines.push(
    `Silvan needs a ${options.providerLabel} API key to generate plans and code.`,
  );
  lines.push('');
  lines.push('Set it in your environment:');
  lines.push(`  export ${options.envVar}=<token>`);
  lines.push('');
  lines.push('Or add to .env file:');
  lines.push(`  ${options.envVar}=<token>`);
  lines.push('');
  lines.push(`Get your API key at: ${options.url}`);
  return lines.join('\n');
}

export function renderWorkflowOverview(): string {
  const lines: string[] = [];
  lines.push(renderQuickstartStep('Step 3: Workflow overview'));
  lines.push('Silvan automates the development loop:');
  lines.push('');
  lines.push('  Task -> Plan -> Implement -> Verify -> PR -> Review');
  lines.push('  Start   AI plans   AI codes    Lint/Test   Open PR  Iterate');
  lines.push('');
  lines.push('Each task runs in an isolated worktree.');
  lines.push('This keeps AI changes separate from your main work.');
  return lines.join('\n');
}

function formatCheckStatus(status: QuickstartCheck['status']): string {
  switch (status) {
    case 'ok':
      return colors.success('ok');
    case 'warn':
      return colors.warning('warn');
    case 'fail':
      return colors.error('fail');
    default:
      return colors.dim('info');
  }
}
