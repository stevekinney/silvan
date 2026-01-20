import type { InitAssistResult, InitContext, InitResult } from '../config/init';
import { hasInitSuggestions } from '../config/init';
import { formatKeyValues, padLabel, renderSectionHeader } from './output';

const LINE_WIDTH = 60;
const LABEL_WIDTH = 16;

export function renderInitHeader(title = 'Silvan Configuration'): string {
  return renderSectionHeader(title, { width: LINE_WIDTH, kind: 'minor' });
}

export function renderInitDetection(context: InitContext): string {
  const lines: string[] = [];
  lines.push(renderSectionHeader('Auto-detected', { width: LINE_WIDTH, kind: 'minor' }));

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

  lines.push(...formatKeyValues(details, { labelWidth: LABEL_WIDTH }));

  lines.push('');
  lines.push(
    renderSectionHeader('Verify commands', { width: LINE_WIDTH, kind: 'minor' }),
  );
  if (context.detection.verifyCommands.length === 0) {
    lines.push(
      ...formatKeyValues([['Scripts', 'None detected']], { labelWidth: LABEL_WIDTH }),
    );
  } else {
    lines.push(
      ...context.detection.verifyCommands.map(
        (command) => `${padLabel(command.name, LABEL_WIDTH)} ${command.cmd}`,
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
  lines.push(
    renderSectionHeader('Existing config', { width: LINE_WIDTH, kind: 'minor' }),
  );
  lines.push(
    ...formatKeyValues([['Path', context.existingConfigPath]], {
      labelWidth: LABEL_WIDTH,
    }),
  );

  if (changes && changes.length > 0) {
    lines.push(
      `${padLabel('Missing', LABEL_WIDTH)} ${changes.length} setting${
        changes.length === 1 ? '' : 's'
      }`,
    );
    for (const change of changes) {
      lines.push(`${' '.repeat(LABEL_WIDTH)} - ${change}`);
    }
  } else {
    lines.push(
      ...formatKeyValues([['Status', 'Up to date']], { labelWidth: LABEL_WIDTH }),
    );
  }

  return lines.join('\n');
}

export function renderInitResult(result: InitResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(renderSectionHeader('Init result', { width: LINE_WIDTH, kind: 'minor' }));

  if (result.action === 'created') {
    lines.push(
      ...formatKeyValues([['Created', result.path ?? 'silvan.config.ts']], {
        labelWidth: LABEL_WIDTH,
      }),
    );
  } else if (result.action === 'updated') {
    lines.push(
      ...formatKeyValues([['Updated', result.path ?? 'silvan.config.ts']], {
        labelWidth: LABEL_WIDTH,
      }),
    );
    if (result.backupPath) {
      lines.push(
        ...formatKeyValues([['Backup', result.backupPath]], {
          labelWidth: LABEL_WIDTH,
        }),
      );
    }
  } else {
    lines.push(
      ...formatKeyValues([['Status', 'No changes applied']], {
        labelWidth: LABEL_WIDTH,
      }),
    );
  }

  if (result.changes && result.changes.length > 0) {
    lines.push(
      `${padLabel('Changes', LABEL_WIDTH)} ${result.changes.length} setting${
        result.changes.length === 1 ? '' : 's'
      }`,
    );
    for (const change of result.changes) {
      lines.push(`${' '.repeat(LABEL_WIDTH)} - ${change}`);
    }
  }

  return lines.join('\n');
}

export function renderInitAssist(
  result: InitAssistResult | null,
  options?: { applied?: boolean; error?: string | null },
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    renderSectionHeader('Cognition defaults', { width: LINE_WIDTH, kind: 'minor' }),
  );

  if (options?.error) {
    lines.push(
      ...formatKeyValues(
        [
          ['Status', 'Unavailable'],
          ['Reason', options.error],
        ],
        { labelWidth: LABEL_WIDTH },
      ),
    );
    return lines.join('\n');
  }

  if (!result || !hasInitSuggestions(result.suggestions)) {
    lines.push(
      ...formatKeyValues([['Status', 'No changes suggested']], {
        labelWidth: LABEL_WIDTH,
      }),
    );
    return lines.join('\n');
  }

  lines.push(
    ...formatKeyValues(
      [['Status', options?.applied ? 'Applied to defaults' : 'Suggested']],
      { labelWidth: LABEL_WIDTH },
    ),
  );

  if (result.notes.length > 0) {
    lines.push(`${padLabel('Notes', LABEL_WIDTH)} ${result.notes[0]}`);
    for (const note of result.notes.slice(1)) {
      lines.push(`${' '.repeat(LABEL_WIDTH)} ${note}`);
    }
  }

  const suggestions = result.suggestions;
  const details: Array<[string, string]> = [];
  if (suggestions.worktreeDir) {
    details.push(['Worktree dir', suggestions.worktreeDir]);
  }
  if (suggestions.enabledProviders?.length) {
    details.push(['Providers', suggestions.enabledProviders.join(', ')]);
  }
  if (suggestions.defaultProvider) {
    details.push(['Default provider', suggestions.defaultProvider]);
  }
  if (details.length > 0) {
    lines.push(...formatKeyValues(details, { labelWidth: LABEL_WIDTH }));
  }
  if (suggestions.verifyCommands?.length) {
    lines.push(`${padLabel('Verify', LABEL_WIDTH)} suggested commands`);
    lines.push(
      ...suggestions.verifyCommands.map(
        (command) => `${padLabel(command.name, LABEL_WIDTH)} ${command.cmd}`,
      ),
    );
  }

  return lines.join('\n');
}
