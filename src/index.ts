import { run } from './cli/cli';

if (import.meta.main) {
  await run(process.argv);
}
