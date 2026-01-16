import { defineConfig } from './src/config/define-config';

export default defineConfig({
  task: {
    providers: {
      enabled: ['local', 'linear', 'github'],
      default: 'local',
    },
    github: {
      closeOnSuccess: false,
      commentOnPrOpen: false,
    },
    linear: {
      states: {
        inProgress: 'In Progress',
      },
    },
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
});
