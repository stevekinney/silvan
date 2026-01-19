export type HelpTopicCategory = 'Concepts' | 'Configuration';

export type HelpTopicSection = {
  title: string;
  lines: string[];
};

export type HelpTopic = {
  id: string;
  title: string;
  summary: string;
  category: HelpTopicCategory;
  intro: string[];
  sections: HelpTopicSection[];
  examples?: string[];
  seeAlso?: string[];
  aliases?: string[];
};

export type HelpTopicGroup = {
  category: HelpTopicCategory;
  topics: HelpTopic[];
};

const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'worktrees',
    title: 'Git Worktrees',
    summary: 'Git worktrees and isolation.',
    category: 'Concepts',
    intro: [
      'Silvan uses git worktrees to isolate each task in its own directory.',
      'Each worktree has its own branch but shares the same git history.',
    ],
    sections: [
      {
        title: 'What is a worktree?',
        lines: [
          'A worktree is a separate working directory linked to your repository.',
          'Each worktree has its own branch, files, and uncommitted changes.',
        ],
      },
      {
        title: 'Why worktrees help',
        lines: [
          '- Run multiple tasks in parallel without branch conflicts.',
          '- Keep AI changes isolated from your main checkout.',
          '- Avoid stash or merge juggling.',
        ],
      },
      {
        title: 'Directory layout',
        lines: ['repo/', '  .git/', '  .worktrees/', '    add-feature/', '  src/'],
      },
      {
        title: 'Worktree commands',
        lines: [
          'silvan tree list',
          'silvan tree add <name>',
          'silvan tree remove <name>',
          'silvan tree clean',
        ],
      },
      {
        title: 'Workflow',
        lines: [
          '1) silvan task start "Add feature"',
          '2) cd .worktrees/add-feature',
          '3) silvan agent run --apply',
          '4) silvan pr open',
          '5) silvan tree clean',
        ],
      },
    ],
    seeAlso: ['silvan tree list', 'silvan tree clean', 'silvan task start "Your task"'],
    aliases: ['worktree'],
  },
  {
    id: 'convergence',
    title: 'Run Convergence',
    summary: 'Run states and what blocks or unblocks runs.',
    category: 'Concepts',
    intro: [
      'Convergence describes whether a run can keep moving without intervention.',
      'Use it to decide when to wait, resume, or fix an issue.',
    ],
    sections: [
      {
        title: 'States',
        lines: [
          'running: The run is actively executing.',
          'converged: The run completed successfully.',
          'blocked: A deterministic gate failed and needs attention.',
          'waiting_for_ci: CI checks are running; auto-resume when complete.',
          'waiting_for_review: PR is open and waiting for review.',
          'waiting_for_user: Run needs manual input or a decision.',
          'failed: Run encountered an unrecoverable error.',
        ],
      },
      {
        title: 'Commands',
        lines: [
          'silvan run status <runId>',
          'silvan run explain <runId>',
          'silvan run resume <runId>',
          'silvan run override <runId> "reason"',
        ],
      },
      {
        title: 'Common blockers',
        lines: [
          '- Verification command failed.',
          '- Review has unresolved threads.',
          '- Local review gate blocked the run.',
        ],
      },
    ],
    seeAlso: [
      'silvan run status <runId>',
      'silvan help verification',
      'silvan help review-loops',
    ],
  },
  {
    id: 'task-refs',
    title: 'Task References',
    summary: 'How to reference GitHub, Linear, and local tasks.',
    category: 'Concepts',
    intro: [
      'Silvan accepts task references in several formats.',
      'This lets you start work from GitHub, Linear, or a local description.',
    ],
    sections: [
      {
        title: 'GitHub issues',
        lines: [
          'Formats: gh-123, #123',
          'URL: https://github.com/owner/repo/issues/123',
          'The issue title becomes the task title.',
          'Example:',
          '  silvan task start gh-42',
          '  silvan task start https://github.com/acme/app/issues/42',
        ],
      },
      {
        title: 'Linear issues',
        lines: [
          'Format: ENG-456 (uses your team prefix)',
          'URL: https://linear.app/<team>/issue/ENG-456',
          'Requires LINEAR_API_KEY.',
          'Example:',
          '  silvan task start ENG-99',
        ],
      },
      {
        title: 'Local tasks',
        lines: [
          'Format: plain text description',
          'Example:',
          '  silvan task start "Add dark mode toggle"',
          '  silvan task start "Fix the login bug on mobile"',
        ],
      },
    ],
    seeAlso: ['silvan task start --help', 'silvan help providers'],
    aliases: ['task-refs', 'taskrefs', 'task refs'],
  },
  {
    id: 'verification',
    title: 'Verification Commands',
    summary: 'Verify commands and safety gates.',
    category: 'Concepts',
    intro: [
      'Verification commands run after implementation to catch regressions.',
      'They are a deterministic gate before PR or review steps.',
    ],
    sections: [
      {
        title: 'Configuration',
        lines: [
          'In silvan.config.ts:',
          '  verify: {',
          "    commands: [{ name: 'lint', cmd: 'bun run lint' }],",
          '    failFast: false,',
          '  },',
        ],
      },
      {
        title: 'Behavior',
        lines: [
          'failFast: true stops after the first failure.',
          'failFast: false runs all commands.',
        ],
      },
      {
        title: 'Results',
        lines: [
          'passed: command exited 0',
          'failed: command exited non-zero',
          'skipped: not run due to failFast or dependencies',
        ],
      },
      {
        title: 'When verification fails',
        lines: [
          'silvan run explain <runId> to see the failure.',
          'Fix the issue, then silvan run resume <runId>.',
          'Use silvan run override only when necessary.',
        ],
      },
    ],
    seeAlso: ['silvan help convergence', 'silvan config show'],
  },
  {
    id: 'review-loops',
    title: 'Review Loops',
    summary: 'PR review automation and iteration.',
    category: 'Concepts',
    intro: [
      'Silvan can open PRs and iterate on review feedback.',
      'Review loops keep changes moving until comments are resolved.',
    ],
    sections: [
      {
        title: 'Workflow',
        lines: [
          '1) Open or update the PR.',
          '2) Wait for CI checks.',
          '3) Fetch and classify review threads.',
          '4) Plan and apply fixes.',
          '5) Verify and push updates.',
          '6) Repeat until resolved.',
        ],
      },
      {
        title: 'Blocking states',
        lines: [
          'waiting_for_review: PR is open and awaiting reviewers.',
          'blocked: review or local gate failed.',
        ],
      },
      {
        title: 'Commands',
        lines: [
          'silvan review unresolved',
          'silvan pr open',
          'silvan run explain <runId>',
        ],
      },
    ],
    seeAlso: ['silvan review unresolved', 'silvan help convergence'],
    aliases: ['review-loops', 'review loops'],
  },
  {
    id: 'state-storage',
    title: 'State Storage',
    summary: 'Global vs repo state, and where data lives.',
    category: 'Concepts',
    intro: [
      'Silvan stores run state, logs, artifacts, and queues outside your repo by default.',
      'You can switch to repo-local state for portability.',
    ],
    sections: [
      {
        title: 'Global state (default)',
        lines: [
          'Uses an OS-specific data directory from env-paths.',
          'Example locations:',
          '  macOS: ~/Library/Application Support/silvan',
          '  Linux: ~/.local/share/silvan',
          '  Windows: %APPDATA%\\silvan',
          'Each repo gets dataRoot/repos/<repoId>.',
        ],
      },
      {
        title: 'Repo state',
        lines: [
          "Set state.mode = 'repo' to store under .silvan/ in the repo.",
          'Optional: set state.root to override the global root.',
          'Example:',
          "  state: { mode: 'repo' }",
        ],
      },
      {
        title: 'Stored data',
        lines: [
          '- Runs and snapshots',
          '- Audit logs',
          '- Artifacts and reports',
          '- Conversations and queue requests',
        ],
      },
    ],
    seeAlso: ['silvan config show', 'silvan run list', 'silvan logs <runId>'],
    aliases: ['state', 'storage'],
  },
  {
    id: 'ai-models',
    title: 'AI Models',
    summary: 'Model selection and phase overrides.',
    category: 'Configuration',
    intro: [
      'Silvan can use different models per phase.',
      'Defaults can be set in config or overridden by CLI flags.',
    ],
    sections: [
      {
        title: 'Configuration',
        lines: [
          'In silvan.config.ts:',
          '  ai: {',
          '    models: {',
          "      default: 'claude-sonnet-4-20250514',",
          "      plan: 'claude-opus-4-20250514',",
          '    },',
          '  },',
        ],
      },
      {
        title: 'CLI overrides',
        lines: [
          '--model sets the default model for all phases.',
          '--model-plan, --model-execute, --model-review override per phase.',
        ],
      },
      {
        title: 'Cognition models',
        lines: [
          'Cognition models are used for review/CI summarization.',
          'Prefer config unless you need a one-off override.',
        ],
      },
    ],
    seeAlso: ['silvan config show', 'silvan help budgets'],
    aliases: ['models'],
  },
  {
    id: 'budgets',
    title: 'Budgets and Limits',
    summary: 'Token and turn limits for safety.',
    category: 'Configuration',
    intro: [
      'Budgets limit cost and turn count for safety.',
      'Set defaults and per-phase overrides in config.',
    ],
    sections: [
      {
        title: 'Limits you can set',
        lines: [
          'maxTurns: maximum agent turns',
          'maxBudgetUsd: spending cap',
          'maxThinkingTokens: per-session thinking tokens',
        ],
      },
      {
        title: 'Configuration',
        lines: [
          'In silvan.config.ts:',
          '  ai: {',
          '    budgets: {',
          '      default: { maxTurns: 50, maxBudgetUsd: 10 },',
          '      plan: { maxTurns: 20 },',
          '    },',
          '  },',
        ],
      },
      {
        title: 'CLI overrides',
        lines: [
          '--max-turns, --max-budget-usd, --max-thinking-tokens',
          'Phase-specific flags exist (for example, --max-turns-plan).',
        ],
      },
    ],
    seeAlso: ['silvan config show', 'silvan help ai-models'],
    aliases: ['limits'],
  },
  {
    id: 'providers',
    title: 'Task Providers',
    summary: 'GitHub, Linear, and local task configuration.',
    category: 'Configuration',
    intro: [
      'Providers control where tasks come from and which integrations are enabled.',
      'Silvan supports GitHub, Linear, and local tasks.',
    ],
    sections: [
      {
        title: 'Enable providers',
        lines: [
          'In silvan.config.ts:',
          '  task: {',
          '    providers: {',
          "      enabled: ['github', 'linear', 'local'],",
          "      default: 'github',",
          '    },',
          '  },',
        ],
      },
      {
        title: 'Auth tokens',
        lines: [
          'GitHub: GITHUB_TOKEN or github.token',
          'Linear: LINEAR_API_KEY or linear.token',
        ],
      },
      {
        title: 'Behavior',
        lines: [
          'GitHub and Linear tasks supply title, description, and metadata.',
          'Local tasks accept a plain text description.',
        ],
      },
    ],
    seeAlso: ['silvan help task-refs', 'silvan init', 'silvan doctor'],
    aliases: ['provider', 'providers'],
  },
];

const CATEGORY_ORDER: HelpTopicCategory[] = ['Concepts', 'Configuration'];

export function listHelpTopics(): HelpTopic[] {
  return HELP_TOPICS;
}

export function groupHelpTopics(topics: HelpTopic[]): HelpTopicGroup[] {
  const grouped = new Map<HelpTopicCategory, HelpTopic[]>();
  for (const topic of topics) {
    if (!grouped.has(topic.category)) {
      grouped.set(topic.category, []);
    }
    grouped.get(topic.category)!.push(topic);
  }

  return CATEGORY_ORDER.flatMap((category) => {
    const items = grouped.get(category);
    return items ? [{ category, topics: items }] : [];
  });
}

export function normalizeHelpTopicId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function findHelpTopic(input: string): HelpTopic | undefined {
  const normalized = normalizeHelpTopicId(input);
  return HELP_TOPICS.find((topic) => {
    const ids = [topic.id, ...(topic.aliases ?? [])].map(normalizeHelpTopicId);
    return ids.includes(normalized);
  });
}
