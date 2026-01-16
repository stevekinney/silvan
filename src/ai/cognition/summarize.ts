import { z } from 'zod';

import type { Config } from '../../config/schema';
import type { EventBus } from '../../events/bus';
import type { EmitContext } from '../../events/emit';
import type { ConversationSnapshot } from '../conversation/types';
import { invokeCognition } from '../router';

const summarySchema = z.object({
  summary: z.string().min(1),
});

export async function summarizeConversation(options: {
  snapshot: ConversationSnapshot;
  config: Config;
  bus?: EventBus;
  context?: EmitContext;
}): Promise<string> {
  const result = await invokeCognition({
    snapshot: options.snapshot,
    task: 'conversationSummary',
    schema: summarySchema,
    config: options.config,
    ...(options.bus ? { bus: options.bus } : {}),
    ...(options.context ? { context: options.context } : {}),
  });
  return result.summary;
}
