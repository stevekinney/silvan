import { createInterface } from 'node:readline/promises';

export async function confirmAction(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${prompt} (y/N) `);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}
