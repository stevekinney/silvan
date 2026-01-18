import { createInterface } from 'node:readline/promises';

export async function confirmAction(
  prompt: string,
  options?: { defaultValue?: boolean },
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error('Confirmation required. Re-run with --yes in non-interactive mode.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const defaultValue = options?.defaultValue ?? false;
  const suffix = defaultValue ? ' (Y/n) ' : ' (y/N) ';
  const answer = await rl.question(`${prompt}${suffix}`);
  rl.close();
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === 'y' || normalized === 'yes';
}
