import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';
import { z } from 'zod';

import type { ConversationStore } from '../ai/conversation/types';
import { invokeCognition } from '../ai/router';
import type { Config } from '../config/schema';
import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';

export const learningNotesSchema = z
  .object({
    summary: z.string().min(1),
    rules: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    docs: z.array(z.string()).default([]),
  })
  .strict();

export type LearningNotes = z.infer<typeof learningNotesSchema>;

export type LearningInput = {
  task?: { key?: string; title?: string; provider?: string };
  diffStat?: string;
  planSummary?: string;
  implementationSummary?: string;
  verification?: { ok?: boolean };
  localGate?: { ok?: boolean; blockers?: number; warnings?: number };
  review?: { unresolved?: number; actionable?: number };
  ciFixSummary?: { summary?: string };
  blockedReason?: string;
  pr?: { url?: string };
};

export async function generateLearningNotes(options: {
  input: LearningInput;
  store: ConversationStore;
  config: Config;
  cacheDir?: string;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<LearningNotes> {
  if (!options.config.learning.ai.enabled) {
    return buildDeterministicLearningNotes(options.input);
  }

  const systemWriter = new ProseWriter();
  systemWriter.write('You are a documentation assistant.');
  systemWriter.write(
    'Return JSON: { summary: string, rules: string[], skills: string[], docs: string[] }.',
  );
  systemWriter.write('Be concise and factual. Avoid speculation.');

  const userWriter = new ProseWriter();
  userWriter.write(JSON.stringify(options.input));

  const snapshot = await options.store.append([
    {
      role: 'system',
      content: systemWriter.toString().trimEnd(),
      metadata: { kind: 'learning' },
    },
    {
      role: 'user',
      content: userWriter.toString().trimEnd(),
      metadata: { kind: 'learning' },
    },
  ]);

  const notes = await invokeCognition({
    snapshot,
    task: 'learningNotes',
    schema: learningNotesSchema,
    config: options.config,
    ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
    ...(options.bus ? { bus: options.bus } : {}),
    ...(options.context ? { context: options.context } : {}),
  });

  const summaryLines = [
    `Summary: ${notes.summary}`,
    ...(notes.rules.length ? [`Rules: ${notes.rules.join('; ')}`] : []),
    ...(notes.skills.length ? [`Skills: ${notes.skills.join('; ')}`] : []),
    ...(notes.docs.length ? [`Docs: ${notes.docs.join('; ')}`] : []),
  ];
  const updatedConversation = appendMessages(snapshot.conversation, {
    role: 'assistant',
    content: `Learning notes:\n${summaryLines.join('\n')}`,
    metadata: { kind: 'learning', protected: true },
  });
  await options.store.save(updatedConversation);

  return notes;
}

export function renderLearningMarkdown(
  runId: string,
  input: LearningInput,
  notes: LearningNotes,
): string {
  const writer = new ProseWriter();
  writer.write(`# Learning notes (${runId})`);
  writer.write(`Generated at ${new Date().toISOString()}`);
  if (input.task?.title || input.task?.key) {
    writer.write(`Task: ${input.task?.key ?? ''} ${input.task?.title ?? ''}`.trim());
  }
  if (input.diffStat) {
    writer.write('## Diffstat');
    writer.write(input.diffStat);
  }
  writer.write('## Summary');
  writer.write(notes.summary);
  if (notes.rules.length > 0) {
    writer.write('## Rules updates');
    for (const rule of notes.rules) writer.write(`- ${rule}`);
  }
  if (notes.skills.length > 0) {
    writer.write('## Skills updates');
    for (const skill of notes.skills) writer.write(`- ${skill}`);
  }
  if (notes.docs.length > 0) {
    writer.write('## Doc updates');
    for (const doc of notes.docs) writer.write(`- ${doc}`);
  }
  return `${writer.toString().trimEnd()}\n`;
}

export async function applyLearningNotes(options: {
  runId: string;
  worktreeRoot: string;
  notes: LearningNotes;
  targets: { rules?: string; skills?: string; docs?: string };
}): Promise<{ appliedTo: string[] }> {
  const { mkdir, appendFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const appliedTo: string[] = [];
  const timestamp = new Date().toISOString();

  const entries: Array<{ target: string; items: string[]; includeSummary: boolean }> = [];
  if (options.targets.rules) {
    entries.push({
      target: options.targets.rules,
      items: options.notes.rules,
      includeSummary: false,
    });
  }
  if (options.targets.skills) {
    entries.push({
      target: options.targets.skills,
      items: options.notes.skills,
      includeSummary: false,
    });
  }
  if (options.targets.docs) {
    entries.push({
      target: options.targets.docs,
      items: options.notes.docs,
      includeSummary: true,
    });
  }

  for (const entry of entries) {
    if (entry.items.length === 0 && !entry.includeSummary) continue;
    const filePath = path.isAbsolute(entry.target)
      ? entry.target
      : path.join(options.worktreeRoot, entry.target);
    await mkdir(path.dirname(filePath), { recursive: true });
    const writer = new ProseWriter();
    writer.write(`## ${timestamp} (run ${options.runId})`);
    if (entry.includeSummary) {
      writer.write(options.notes.summary);
    }
    for (const item of entry.items) {
      writer.write(`- ${item}`);
    }
    const content = `\n${writer.toString().trimEnd()}\n`;
    await appendFile(filePath, content, 'utf8');
    appliedTo.push(filePath);
  }

  return { appliedTo };
}

function buildDeterministicLearningNotes(input: LearningInput): LearningNotes {
  const lines: string[] = [];
  if (input.diffStat) lines.push(`Changes: ${input.diffStat}`);
  if (input.verification && input.verification.ok === false) {
    lines.push('Verification failed at least once and was fixed.');
  }
  if (input.localGate && input.localGate.ok === false) {
    lines.push('Local review gate blockers were addressed.');
  }
  if (input.review && (input.review.unresolved ?? 0) > 0) {
    lines.push('Review comments were addressed.');
  }
  if (input.ciFixSummary?.summary) {
    lines.push(`CI fix: ${input.ciFixSummary.summary}`);
  }
  if (input.blockedReason) {
    lines.push(`Blocked reason: ${input.blockedReason}`);
  }
  const summary = lines.length > 0 ? lines.join(' ') : 'Run completed successfully.';

  const docs: string[] = [];
  if (input.ciFixSummary?.summary) {
    docs.push('Document CI failure handling and rerun policy.');
  }
  if (input.verification && input.verification.ok === false) {
    docs.push('Update verification documentation with common failure modes.');
  }
  if (input.review && (input.review.unresolved ?? 0) > 0) {
    docs.push('Capture review themes in team guidelines.');
  }

  return { summary, rules: [], skills: [], docs };
}
