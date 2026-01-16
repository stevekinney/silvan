import type { Config } from '../../config/schema';
import type { ConversationPruningPolicy } from './types';

export function getConversationPruningPolicy(config: Config): ConversationPruningPolicy {
  const pruning = config.ai.conversation.pruning;
  return {
    maxTurns: pruning.maxTurns,
    maxBytes: pruning.maxBytes,
    summarizeAfterTurns: pruning.summarizeAfterTurns,
    keepLastTurns: pruning.keepLastTurns,
  };
}
