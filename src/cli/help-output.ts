import type { CAC, Command } from 'cac';

import { padLabel } from './output';

type HelpSection = { title?: string; body: string };

type HelpMeta = {
  examples?: string[];
  seeAlso?: string[];
  aliases?: string[];
};

type OptionEntry = Command['options'][number];
type CommandArg = Command['args'][number];
type OptionGroup =
  | 'Auth'
  | 'AI'
  | 'Limits'
  | 'Output'
  | 'Behavior'
  | 'Task input'
  | 'State'
  | 'Other';

const COMMAND_META: Record<string, HelpMeta> = {
  'task start': {
    examples: [
      'silvan task start "Fix login bug"',
      'silvan task start gh-42 --yes',
      'silvan task start ENG-99 --model claude-sonnet-4-20250514',
    ],
    seeAlso: [
      'silvan agent plan',
      'silvan agent run',
      'silvan tree list',
      'silvan help task-refs',
    ],
  },
  'tree add': {
    examples: ['silvan tree add my-feature', 'silvan tree add my-feature --yes'],
    seeAlso: [
      'silvan tree list',
      'silvan task start "Your task"',
      'silvan help worktrees',
    ],
  },
  'tree remove': {
    examples: ['silvan tree remove my-feature', 'silvan tree remove --task gh-42'],
    seeAlso: ['silvan tree list', 'silvan tree clean', 'silvan help worktrees'],
  },
  'tree clean': {
    examples: ['silvan tree clean', 'silvan tree clean --all'],
    seeAlso: ['silvan tree list', 'silvan tree prune', 'silvan help worktrees'],
  },
  'run list': {
    examples: ['silvan run list', 'silvan run list --status blocked'],
    seeAlso: ['silvan run inspect <runId>', 'silvan run status <runId>'],
  },
  analytics: {
    examples: [
      'silvan analytics',
      'silvan analytics --since 7d --provider github',
      'silvan analytics --repo depict --json',
    ],
    seeAlso: ['silvan run list', 'silvan run status <runId>'],
  },
  'models recommend': {
    examples: ['silvan models recommend', 'silvan models recommend --min-samples 20'],
    seeAlso: ['silvan models benchmark', 'silvan config show'],
  },
  'models benchmark': {
    examples: [
      'silvan models benchmark --models model-a,model-b',
      'silvan models benchmark --models claude-sonnet-4-20250514,claude-opus-4-20250514',
    ],
    seeAlso: ['silvan models recommend', 'silvan config show'],
  },
  'run inspect': {
    examples: ['silvan run inspect <runId>', 'silvan run inspect <runId> --json'],
    seeAlso: ['silvan run list', 'silvan run status <runId>'],
  },
  'run status': {
    examples: ['silvan run status <runId>', 'silvan run status <runId> --json'],
    seeAlso: [
      'silvan run explain <runId>',
      'silvan run resume <runId>',
      'silvan help convergence',
    ],
  },
  'run explain': {
    examples: ['silvan run explain <runId>', 'silvan run explain <runId> --json'],
    seeAlso: [
      'silvan run status <runId>',
      'silvan run resume <runId>',
      'silvan help convergence',
    ],
  },
  'run resume': {
    examples: [
      'silvan run resume <runId> --apply',
      'silvan run resume <runId> --dry-run',
    ],
    seeAlso: [
      'silvan run status <runId>',
      'silvan run override <runId> "reason"',
      'silvan help convergence',
    ],
  },
  'run override': {
    examples: [
      'silvan run override <runId> "override reason"',
      'silvan run status <runId>',
    ],
    seeAlso: ['silvan run explain <runId>', 'silvan run resume <runId>'],
  },
  'run abort': {
    examples: ['silvan run abort <runId>', 'silvan run abort <runId> "reason"'],
    seeAlso: ['silvan run status <runId>', 'silvan run list'],
  },
  'pr open': {
    examples: ['silvan pr open', 'silvan pr open --json'],
    seeAlso: ['silvan ci wait', 'silvan review unresolved'],
  },
  'ci wait': {
    examples: ['silvan ci wait', 'silvan ci wait --timeout 120000'],
    seeAlso: ['silvan pr open', 'silvan run status <runId>'],
  },
  'review unresolved': {
    examples: ['silvan review unresolved', 'silvan review unresolved --json'],
    seeAlso: ['silvan pr open', 'silvan run explain <runId>', 'silvan help review-loops'],
  },
  init: {
    examples: ['silvan init', 'silvan init --yes'],
    seeAlso: ['silvan doctor', 'silvan config show', 'silvan help providers'],
  },
  quickstart: {
    examples: ['silvan quickstart', 'silvan quickstart --yes'],
    seeAlso: ['silvan init', 'silvan doctor', 'silvan task start "Your task"'],
  },
  help: {
    examples: ['silvan help', 'silvan help worktrees', 'silvan help task-refs'],
    seeAlso: ['silvan --help', 'silvan quickstart'],
  },
  doctor: {
    examples: ['silvan doctor', 'silvan doctor --network'],
    seeAlso: ['silvan config validate', 'silvan config show', 'silvan help providers'],
  },
  'config show': {
    examples: ['silvan config show', 'silvan config show --json'],
    seeAlso: ['silvan config validate', 'silvan init', 'silvan help ai-models'],
  },
  'config validate': {
    examples: ['silvan config validate', 'silvan config validate --json'],
    seeAlso: ['silvan config show', 'silvan doctor', 'silvan help budgets'],
  },
  logs: {
    examples: ['silvan logs <runId>', 'silvan logs <runId> --tail 50'],
    seeAlso: ['silvan run list', 'silvan run inspect <runId>'],
  },
  ui: {
    examples: ['silvan ui', 'silvan ui --help'],
    seeAlso: ['silvan run list', 'silvan run status <runId>'],
  },
  'agent plan': {
    examples: ['silvan agent plan', 'silvan agent plan --json'],
    seeAlso: ['silvan task start "Your task"', 'silvan agent run --apply'],
  },
  'agent clarify': {
    examples: ['silvan agent clarify', 'silvan agent clarify --answer question-id=value'],
    seeAlso: ['silvan task start "Your task"', 'silvan agent plan'],
  },
  'agent run': {
    examples: ['silvan agent run --apply', 'silvan agent run --dry-run'],
    seeAlso: ['silvan pr open', 'silvan run status <runId>', 'silvan help verification'],
  },
  'agent resume': {
    examples: ['silvan agent resume', 'silvan agent resume --apply'],
    seeAlso: ['silvan agent run --apply', 'silvan run status <runId>'],
  },
  'queue run': {
    examples: [
      'silvan queue run',
      'silvan queue run --concurrency 3',
      'silvan queue run --continue-on-error',
      'silvan queue run --json',
    ],
    seeAlso: ['silvan queue status', 'silvan task start --queue "Your task"'],
  },
  'queue status': {
    examples: ['silvan queue status', 'silvan queue status --json'],
    seeAlso: ['silvan queue run', 'silvan task start --queue "Your task"'],
  },
  'queue priority': {
    examples: [
      'silvan queue priority <requestId> 8',
      'silvan queue priority <requestId> 8 --json',
    ],
    seeAlso: ['silvan queue status', 'silvan queue run'],
  },
  'convo show': {
    examples: ['silvan convo show <runId>', 'silvan convo show <runId> --limit 50'],
    seeAlso: ['silvan logs <runId>', 'silvan convo export <runId>'],
  },
  'convo export': {
    examples: ['silvan convo export <runId>', 'silvan convo export <runId> --format md'],
    seeAlso: ['silvan convo show <runId>', 'silvan logs <runId>'],
  },
  'convo optimize': {
    examples: ['silvan convo optimize <runId>', 'silvan convo optimize <runId> --force'],
    seeAlso: ['silvan convo show <runId>', 'silvan convo export <runId>'],
  },
  'learning show': {
    examples: ['silvan learning show <runId>', 'silvan learning show <runId> --json'],
    seeAlso: ['silvan run inspect <runId>', 'silvan convo show <runId>'],
  },
  'learning review': {
    examples: [
      'silvan learning review',
      'silvan learning review --approve <runId>',
      'silvan learning review --reject <runId>',
      'silvan learning review --approve --all',
      'silvan learning review --json',
    ],
    seeAlso: ['silvan learning show <runId>', 'silvan run list'],
  },
  'learning rollback': {
    examples: [
      'silvan learning rollback <runId>',
      'silvan learning rollback <runId> --json',
    ],
    seeAlso: ['silvan learning review', 'silvan run status <runId>'],
  },
  completion: {
    examples: ['silvan completion zsh', 'silvan completion bash'],
    seeAlso: ['silvan --help'],
  },
};

const GLOBAL_ALIASES: Array<[string, string]> = [
  ['t', 'tree'],
  ['wt', 'tree'],
  ['r', 'run'],
  ['a', 'agent'],
];

export function buildHelpSections(sections: HelpSection[], cli: CAC): HelpSection[] {
  const command = cli.matchedCommand ?? cli.globalCommand;
  const name = command?.name ?? '';
  const commandKey = name || 'silvan';
  const meta = COMMAND_META[commandKey] ?? {};

  const nextSections: HelpSection[] = [];

  for (const section of sections) {
    if (section.title === 'Options') continue;
    if (section.title === 'Examples') continue;
    nextSections.push(section);
  }

  if (command?.description) {
    nextSections.splice(2, 0, { title: 'Description', body: `  ${command.description}` });
  }

  const optionSection = buildGroupedOptionsSection(command, cli);
  if (optionSection) {
    nextSections.push(optionSection);
  }

  const jsonSection = buildJsonOutputSection(commandKey);
  if (jsonSection) {
    nextSections.push(jsonSection);
  }

  const examples = buildExamples(commandKey, command, meta.examples);
  if (examples.length > 0) {
    nextSections.push({
      title: 'Examples',
      body: examples.map((line) => `  ${line}`).join('\n'),
    });
  }

  const aliasSection = buildAliasSection(commandKey, meta.aliases);
  if (aliasSection) {
    nextSections.push(aliasSection);
  }

  if (meta.seeAlso && meta.seeAlso.length > 0) {
    nextSections.push({
      title: 'See also',
      body: meta.seeAlso.map((item) => `  ${item}`).join('\n'),
    });
  }

  return nextSections;
}

function buildJsonOutputSection(commandKey: string): HelpSection | null {
  if (commandKey === 'silvan') return null;
  const lines = [
    '  Emits com.silvan.events JSONL on stdout.',
    '  Single-response commands emit cli.result with:',
    '    success, command, data, nextSteps, error',
    '  Long-running commands stream progress events.',
  ];
  return {
    title: 'JSON output',
    body: lines.join('\n'),
  };
}

function buildGroupedOptionsSection(
  command: Command | undefined,
  cli: CAC,
): HelpSection | null {
  if (!command) return null;
  const options = collectOptions(command, cli);
  if (options.length === 0) return null;

  const groups = groupOptions(options);
  const lines: string[] = [];
  const optionWidth = Math.max(...options.map((option) => option.rawName.length), 0);

  for (const [group, groupOptions] of groups) {
    lines.push(`  ${group}`);
    for (const option of groupOptions) {
      const defaultValue =
        option.config?.default === undefined
          ? ''
          : ` (default: ${option.config.default})`;
      lines.push(
        `    ${padLabel(option.rawName, optionWidth)}  ${option.description}${defaultValue}`,
      );
    }
    lines.push('');
  }

  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return { title: 'Options', body: lines.join('\n') };
}

function collectOptions(command: Command, cli: CAC): OptionEntry[] {
  let options: OptionEntry[] = command.isGlobalCommand
    ? (cli.globalCommand.options ?? [])
    : [...(command.options ?? []), ...(cli.globalCommand.options ?? [])];

  if (!command.isGlobalCommand && !command.isDefaultCommand) {
    options = options.filter((option) => option.name !== 'version');
  }

  return options;
}

function groupOptions(options: OptionEntry[]): Array<[OptionGroup, OptionEntry[]]> {
  const groups: Record<OptionGroup, OptionEntry[]> = {
    Auth: [],
    AI: [],
    Limits: [],
    Output: [],
    Behavior: [],
    'Task input': [],
    State: [],
    Other: [],
  };

  for (const option of options) {
    const name = option.name;
    const group = classifyOption(name);
    groups[group].push(option);
  }

  return (Object.entries(groups) as Array<[OptionGroup, OptionEntry[]]>).filter(
    ([, items]) => items.length > 0,
  );
}

function classifyOption(name: string): OptionGroup {
  if (['githubToken', 'linearToken'].includes(name)) return 'Auth';
  if (name.startsWith('model') || name.startsWith('cognition')) return 'AI';
  if (name.startsWith('max') || ['maxToolCalls', 'maxToolMs'].includes(name))
    return 'Limits';
  if (['json', 'debug', 'trace', 'noUi', 'quiet', 'verbose'].includes(name))
    return 'Output';
  if (['stateMode', 'verifyShell', 'persistSessions'].includes(name)) return 'State';
  if (['title', 'desc', 'ac', 'fromFile'].includes(name)) return 'Task input';
  return 'Behavior';
}

function buildAliasSection(
  commandKey: string,
  localAliases?: string[],
): HelpSection | null {
  const entries: string[] = [];

  if (!commandKey || commandKey === 'silvan') {
    for (const [alias, command] of GLOBAL_ALIASES) {
      entries.push(`  ${alias} -> ${command}`);
    }
  } else if (commandKey.startsWith('tree')) {
    entries.push('  t -> tree');
    entries.push('  wt -> tree');
  } else if (commandKey.startsWith('run')) {
    entries.push('  r -> run');
  } else if (commandKey.startsWith('agent')) {
    entries.push('  a -> agent');
  }

  if (localAliases) {
    for (const alias of localAliases) {
      entries.push(`  ${alias}`);
    }
  }

  if (entries.length === 0) return null;
  return { title: 'Aliases', body: entries.join('\n') };
}

function buildExamples(
  commandKey: string,
  command: Command | undefined,
  preferred?: string[],
): string[] {
  if (preferred && preferred.length >= 2) return preferred;

  const examples: string[] = [];
  const args: CommandArg[] = command?.args ?? [];
  if (commandKey && commandKey !== 'silvan') {
    const placeholders = args.map((arg) => placeholderForArg(arg.value));
    const base = `silvan ${commandKey}`;
    if (placeholders.length > 0) {
      examples.push(`${base} ${placeholders.join(' ')}`);
    } else {
      examples.push(base);
    }
    examples.push(`${base} --help`);
  } else {
    examples.push('silvan --help');
    examples.push('silvan init');
  }

  return examples.slice(0, 3);
}

function placeholderForArg(value: string): string {
  switch (value) {
    case 'runId':
      return '<runId>';
    case 'name':
      return 'my-feature';
    case 'shell':
      return 'zsh';
    case 'task':
    case 'taskRef':
    case 'ref':
      return 'gh-42';
    case 'reason':
      return '"reason"';
    default:
      return `<${value}>`;
  }
}
