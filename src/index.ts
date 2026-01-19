import { run } from './cli/cli';
export type { CliResult, JsonError } from './events/schema';

if (import.meta.main) {
  await run(process.argv);
}
