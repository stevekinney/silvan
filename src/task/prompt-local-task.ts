import { createInterface } from 'node:readline/promises';

import type { LocalTaskInput } from './providers/local';

export async function promptLocalTaskInput(): Promise<LocalTaskInput> {
  if (!process.stdin.isTTY) {
    throw new Error('Task prompt requires a TTY.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const titleAnswer = await rl.question('Task title: ');
    const title = titleAnswer.trim();
    if (!title) {
      throw new Error('Task title is required.');
    }
    const descriptionAnswer = await rl.question('Task description (optional): ');
    const description = descriptionAnswer.trim();
    const acceptanceCriteria: string[] = [];
    while (true) {
      const entryAnswer = await rl.question('Acceptance criteria (blank to finish): ');
      const entry = entryAnswer.trim();
      if (!entry) break;
      acceptanceCriteria.push(entry);
    }
    return {
      title,
      ...(description ? { description } : {}),
      ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    };
  } finally {
    rl.close();
  }
}
