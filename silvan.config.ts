import type { Config } from './src/config/schema';

const config: Config = {
  repo: {
    defaultBranch: 'main',
  },
  linear: {
    enabled: true,
    project: undefined,
    teams: [],
    ticketPrefixes: [],
  },
  github: {
    reviewers: [],
    requestCopilot: true,
    baseBranch: undefined,
  },
  verify: {
    commands: [
      { name: 'lint', cmd: 'bun run lint' },
      { name: 'typecheck', cmd: 'bun run typecheck' },
      { name: 'test', cmd: 'bun run test' },
    ],
    failFast: true,
  },
  naming: {
    branchPrefix: 'feature/',
    worktreeDir: '.worktrees',
  },
  features: {
    autoMode: false,
    strictMode: false,
  },
};

export default config;
