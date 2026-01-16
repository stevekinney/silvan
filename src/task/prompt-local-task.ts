import { createInterface } from 'node:readline/promises';

import { SilvanError } from '../core/errors';
import type { LocalTaskInput } from './providers/local';

export async function promptLocalTaskInput(): Promise<LocalTaskInput> {
  if (!process.stdin.isTTY) {
    throw new SilvanError({
      code: 'tty.required',
      message: 'Task prompt requires a TTY.',
      userMessage: 'Task prompt requires a TTY.',
      kind: 'validation',
      nextSteps: ['Run without --yes or provide --title/--desc.'],
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const titleAnswer = await rl.question('Task title: ');
    const title = titleAnswer.trim();
    if (!title) {
      throw new SilvanError({
        code: 'task.title.required',
        message: 'Task title is required.',
        userMessage: 'Task title is required.',
        kind: 'validation',
      });
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
