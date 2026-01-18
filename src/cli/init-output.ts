import type { InitContext, InitResult } from '../config/init';

const LINE_WIDTH = 60;
const LABEL_WIDTH = 16;

export function renderInitHeader(title = 'Silvan Configuration'): string {
  return `${title}\n${'-'.repeat(LINE_WIDTH)}`;
}

export function renderInitDetection(context: InitContext): string {
  const lines: string[] = [];
  lines.push('Auto-detected');
  lines.push('-'.repeat(LINE_WIDTH));

  const details: Array<[string, string]> = [];
  if (context.detection.github) {
    details.push([
      'Repository',
      `github.com/${context.detection.github.owner}/${context.detection.github.repo}`,
    ]);
  } else {
    details.push(['Repository', 'Not detected']);
  }
  details.push(['Default branch', context.detection.defaultBranch]);
  details.push(['Package manager', context.detection.packageManager]);
  details.push(['Worktree dir', context.detection.worktreeDir]);

  lines.push(...formatKeyValues(details));

  lines.push('');
  lines.push('Verify commands');
  lines.push('-'.repeat(LINE_WIDTH));
  if (context.detection.verifyCommands.length === 0) {
    lines.push(...formatKeyValues([['Scripts', 'None detected']]));
  } else {
    lines.push(
      ...context.detection.verifyCommands.map(
        (command) => `${padLabel(command.name)} ${command.cmd}`,
      ),
    );
  }

  return lines.join('\n');
}

export function renderInitExistingConfig(
  context: InitContext,
  changes?: string[],
): string {
  if (!context.existingConfigPath) return '';
  const lines: string[] = [];
  lines.push('');
  lines.push('Existing config');
  lines.push('-'.repeat(LINE_WIDTH));
  lines.push(...formatKeyValues([['Path', context.existingConfigPath]]));

  if (changes && changes.length > 0) {
    lines.push(
      `${padLabel('Missing')} ${changes.length} setting${changes.length === 1 ? '' : 's'}`,
    );
    for (const change of changes) {
      lines.push(`${' '.repeat(LABEL_WIDTH)} - ${change}`);
    }
  } else {
    lines.push(...formatKeyValues([['Status', 'Up to date']]));
  }

  return lines.join('\n');
}

export function renderInitResult(result: InitResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Init result');
  lines.push('-'.repeat(LINE_WIDTH));

  if (result.action === 'created') {
    lines.push(...formatKeyValues([['Created', result.path ?? 'silvan.config.ts']]));
  } else if (result.action === 'updated') {
    lines.push(...formatKeyValues([['Updated', result.path ?? 'silvan.config.ts']]));
    if (result.backupPath) {
      lines.push(...formatKeyValues([['Backup', result.backupPath]]));
    }
  } else {
    lines.push(...formatKeyValues([['Status', 'No changes applied']]));
  }

  if (result.changes && result.changes.length > 0) {
    lines.push(
      `${padLabel('Changes')} ${result.changes.length} setting${result.changes.length === 1 ? '' : 's'}`,
    );
    for (const change of result.changes) {
      lines.push(`${' '.repeat(LABEL_WIDTH)} - ${change}`);
    }
  }

  return lines.join('\n');
}

function formatKeyValues(entries: Array<[string, string]>): string[] {
  return entries.map(([label, value]) => `${padLabel(label)} ${value}`);
}

function padLabel(label: string): string {
  return label.padEnd(LABEL_WIDTH);
}
