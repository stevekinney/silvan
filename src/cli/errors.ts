import { normalizeError, SilvanError } from '../core/errors';
import {
  colors,
  formatKeyList,
  formatKeyValues,
  renderNextSteps,
  renderSectionHeader,
} from './output';

export type CliErrorRenderOptions = {
  debug?: boolean;
  trace?: boolean;
  commandNames?: string[];
  assistant?: { summary?: string; steps?: string[] };
};

export function renderCliError(
  error: unknown,
  options?: CliErrorRenderOptions,
): { error: SilvanError; message: string } {
  const normalized = normalizeError(error);
  const lines: string[] = [];

  lines.push(colors.error(`Error: ${normalized.userMessage}`));

  const meta: Array<[string, string]> = [];
  if (normalized.code) {
    meta.push(['Code', normalized.code]);
  }
  if (normalized.runId) {
    meta.push(['Run ID', normalized.runId]);
  }
  if (normalized.auditLogPath) {
    meta.push(['Audit log', normalized.auditLogPath]);
  }
  if (meta.length > 0) {
    lines.push(...formatKeyValues(meta, { labelWidth: 10 }));
  }

  const details = formatDetails(normalized.details);
  if (details.length > 0) {
    lines.push('Details:');
    for (const detail of details) {
      lines.push(`  - ${detail}`);
    }
  }

  const didYouMean = buildDidYouMean(normalized, options?.commandNames);
  if (didYouMean.length > 0) {
    lines.push('Did you mean?');
    for (const suggestion of didYouMean) {
      lines.push(`  ${suggestion}`);
    }
  }

  const assistant = options?.assistant;
  if (assistant?.summary || assistant?.steps?.length) {
    lines.push('');
    lines.push(renderSectionHeader('Suggested fix', { width: 60, kind: 'minor' }));
    if (assistant.summary) {
      lines.push(
        ...formatKeyValues([['Summary', assistant.summary]], { labelWidth: 10 }),
      );
    }
    if (assistant.steps && assistant.steps.length > 0) {
      lines.push(
        ...formatKeyList(
          'Steps',
          `${assistant.steps.length} action(s)`,
          assistant.steps,
          { labelWidth: 10 },
        ),
      );
    }
  }

  const nextSteps = normalized.nextSteps ? [...normalized.nextSteps] : [];
  for (const step of buildDefaultRecoverySteps(normalized)) {
    if (!nextSteps.includes(step)) {
      nextSteps.push(step);
    }
  }
  const nextStepsBlock = renderNextSteps(nextSteps);
  if (nextStepsBlock) {
    lines.push(nextStepsBlock);
  }

  if (options?.debug || options?.trace) {
    lines.push('');
    lines.push('Debug:');
    if (normalized.stack) {
      lines.push(normalized.stack);
    } else {
      lines.push('No stack available.');
    }
    if (options?.trace && normalized.cause) {
      lines.push('');
      lines.push(`Cause: ${formatCause(normalized.cause)}`);
    }
  }

  return { error: normalized, message: lines.join('\n') };
}

function buildDefaultRecoverySteps(error: SilvanError): string[] {
  const steps: string[] = [];
  if (error.runId) {
    steps.push(`View logs: silvan logs ${error.runId}`);
  }
  switch (error.kind) {
    case 'auth':
      steps.push('Run `silvan doctor --network` to check provider access.');
      break;
    case 'validation':
      steps.push('Run `silvan --help` to review command usage.');
      break;
    case 'not_found':
      steps.push('Run `silvan run list` to find recent runs.');
      break;
    case 'conflict':
      steps.push('Re-run with `--force` if you want to override.');
      break;
    case 'internal':
      steps.push('Re-run with `--debug` for more context.');
      steps.push('Run `silvan doctor` to check your environment.');
      break;
    default:
      break;
  }
  if (steps.length === 0) {
    steps.push('Run `silvan --help` for usage details.');
  }
  return steps;
}

function buildDidYouMean(
  error: SilvanError,
  commandNames: string[] | undefined,
): string[] {
  if (error.code !== 'unknown_command' || !commandNames) return [];
  const unknown = extractUnknownCommand(error.message);
  if (!unknown) return [];
  const suggestions = suggestCommands(unknown, commandNames);
  return suggestions.map((command) => `silvan ${command}`);
}

function extractUnknownCommand(message: string): string | null {
  const match = message.match(/Unknown command:\\s*(.+)$/i);
  return match ? match[1]!.trim() : null;
}

function suggestCommands(input: string, commands: string[]): string[] {
  const normalized = input.toLowerCase();
  const prefixMatches = commands.filter(
    (command) =>
      command.startsWith(normalized) || normalized.startsWith(command.toLowerCase()),
  );
  if (prefixMatches.length > 0) {
    return prefixMatches.slice(0, 3);
  }

  const scored = commands
    .map((command) => ({
      command,
      score: levenshtein(normalized, command.toLowerCase()),
    }))
    .sort((a, b) => a.score - b.score)
    .filter((entry) => entry.score <= 3);

  return scored.slice(0, 3).map((entry) => entry.command);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const matrix = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i += 1) {
    matrix[i]![0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    matrix[0]![j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    const row = matrix[i]!;
    const prevRow = matrix[i - 1]!;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const above = prevRow[j] ?? 0;
      const left = row[j - 1] ?? 0;
      const diag = prevRow[j - 1] ?? 0;
      row[j] = Math.min(above + 1, left + 1, diag + cost);
    }
  }
  return matrix[a.length]?.[b.length] ?? 0;
}

function formatDetails(details: Record<string, unknown> | undefined): string[] {
  if (!details) return [];
  const lines: string[] = [];
  const path = details['path'];
  if (typeof path === 'string') {
    lines.push(`Path: ${path}`);
  }
  const issues = details['issues'];
  if (Array.isArray(issues) && issues.every((issue) => typeof issue === 'string')) {
    lines.push(...issues);
  }
  if (lines.length === 0) {
    lines.push(JSON.stringify(details));
  }
  return lines;
}

function formatCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack ?? cause.message;
  }
  return typeof cause === 'string' ? cause : JSON.stringify(cause);
}
