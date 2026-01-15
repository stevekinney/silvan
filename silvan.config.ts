import type { Config } from './src/config/schema';

const config: Config = {
  verify: {
    commands: [
      { name: 'lint', cmd: 'bun run lint' },
      { name: 'typecheck', cmd: 'bun run typecheck' },
      { name: 'test', cmd: 'bun run test' },
    ],
  },
  naming: {
    branchPrefix: 'feature/',
    worktreeDir: '.worktrees',
  },
};

export default config;
