import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import { type PrDraft, prDraftSchema } from '../../agent/schemas';
import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import { createEnvelope } from '../../events/emit';
import { hashInputs } from '../../prompts';
import { hashString } from '../../utils/hash';
import type { ConversationStore } from '../conversation/types';
import { invokeCognition } from '../router';
import { getCognitionModel, resolveCognitionProvider } from './policy';

export async function draftPullRequest(input: {
  planSummary: string;
  changesSummary: string;
  taskId?: string;
  taskUrl?: string;
  store: ConversationStore;
  config: Config;
  cacheDir?: string;
  bus?: EventBus;
  context?: EmitContext;
  invoke?: typeof invokeCognition;
  client?: Parameters<typeof invokeCognition>[0]['client'];
}): Promise<PrDraft> {
  const systemWriter = new ProseWriter();
  systemWriter.write('You are the PR writer for Silvan.');
  systemWriter.write('Draft a PR title and body based on the plan and change summary.');

  const userWriter = new ProseWriter();
  userWriter.write(`Plan summary: ${input.planSummary}`);
  userWriter.write(`Change summary: ${input.changesSummary}`);
  userWriter.write(`Task: ${input.taskId ?? 'N/A'}`);
  userWriter.write(`Task URL: ${input.taskUrl ?? 'N/A'}`);

  const snapshot = await input.store.append([
    {
      role: 'system',
      content: systemWriter.toString().trimEnd(),
      metadata: { kind: 'pr' },
    },
    {
      role: 'user',
      content: userWriter.toString().trimEnd(),
      metadata: { kind: 'pr' },
    },
  ]);

  const inputsDigest = hashInputs({
    planSummary: input.planSummary,
    changesSummary: input.changesSummary,
    taskId: input.taskId ?? null,
    taskUrl: input.taskUrl ?? null,
  });

  const invoke = input.invoke ?? invokeCognition;
  const draft = await invoke({
    snapshot,
    task: 'prDraft',
    schema: prDraftSchema,
    config: input.config,
    inputsDigest,
    ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
    ...(input.client ? { client: input.client } : {}),
    ...(input.bus ? { bus: input.bus } : {}),
    ...(input.context ? { context: input.context } : {}),
  });

  const planDigest = hashString(JSON.stringify(draft));
  if (input.bus && input.context) {
    const provider = resolveCognitionProvider(input.config);
    const model = getCognitionModel(input.config, 'prDraft');
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_generated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          model: { provider: provider.provider, model },
          planKind: 'pr_draft' as const,
          planDigest,
        },
      }),
    );
  }

  const parsed = prDraftSchema.safeParse(draft);
  if (!parsed.success) {
    if (input.bus && input.context) {
      await input.bus.emit(
        createEnvelope({
          type: 'ai.plan_validated',
          source: 'ai',
          level: 'error',
          context: input.context,
          payload: {
            planDigest,
            valid: false,
            errors: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.') || 'pr_draft',
              message: issue.message,
            })),
          },
        }),
      );
    }
    throw new Error('PR draft validation failed');
  }
  if (input.bus && input.context) {
    await input.bus.emit(
      createEnvelope({
        type: 'ai.plan_validated',
        source: 'ai',
        level: 'info',
        context: input.context,
        payload: {
          planDigest,
          valid: true,
        },
      }),
    );
  }

  const withSummary = appendMessages(snapshot.conversation, {
    role: 'assistant',
    content: `PR draft: ${parsed.data.title}`,
    metadata: { kind: 'pr', protected: true },
  });
  await input.store.save(withSummary);

  return parsed.data;
}
