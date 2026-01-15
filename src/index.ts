import { run } from './cli/cli';

if (import.meta.main) {
  run(process.argv);
}
