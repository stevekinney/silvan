import { createInterface } from 'node:readline/promises';

export type ClarificationQuestion = {
  id: string;
  text: string;
  required?: boolean;
};

export async function collectClarifications(options: {
  questions: ClarificationQuestion[];
  answers?: Record<string, string>;
}): Promise<Record<string, string>> {
  const resolved: Record<string, string> = { ...(options.answers ?? {}) };

  const needsPrompt = options.questions.filter(
    (question) => !resolved[question.id],
  );
  if (needsPrompt.length === 0) {
    return resolved;
  }

  if (!process.stdin.isTTY) {
    return resolved;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const question of needsPrompt) {
      const answer = await rl.question(`${question.text}\n> `);
      const trimmed = answer.trim();
      if (trimmed.length > 0) {
        resolved[question.id] = trimmed;
      }
    }
  } finally {
    rl.close();
  }

  return resolved;
}
