import { z } from 'zod';

import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import type { ConversationSnapshot } from '../conversation/types';
import { invokeCognition } from '../router';

const summarySchema = z.object({
  summary: z.string().min(1),
});
type SummaryResult = z.infer<typeof summarySchema>;
type SummaryClient = Parameters<typeof invokeCognition<SummaryResult>>[0]['client'];

export async function summarizeConversation(options: {
  snapshot: ConversationSnapshot;
  config: Config;
  bus?: EventBus;
  context?: EmitContext;
  invoke?: typeof invokeCognition;
  client?: SummaryClient;
}): Promise<string> {
  const invoke = options.invoke ?? invokeCognition;
  const result = await invoke<SummaryResult>({
    snapshot: options.snapshot,
    task: 'conversationSummary',
    schema: summarySchema,
    config: options.config,
    ...(options.client ? { client: options.client } : {}),
    ...(options.bus ? { bus: options.bus } : {}),
    ...(options.context ? { context: options.context } : {}),
  });
  return result.summary;
}
