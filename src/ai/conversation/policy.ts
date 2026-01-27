import type { Config } from '../../config/schema';
import type { ConversationPruningPolicy } from './types';

export function getConversationPruningPolicy(config: Config): ConversationPruningPolicy {
  const pruning = config.ai.conversation.pruning;
  const optimization = config.ai.conversation.optimization;
  return {
    maxTurns: pruning.maxTurns,
    maxBytes: pruning.maxBytes,
    summarizeAfterTurns: pruning.summarizeAfterTurns,
    keepLastTurns: pruning.keepLastTurns,
    optimization: {
      enabled: optimization.enabled,
      retention: optimization.retention,
      correctionPatterns: optimization.correctionPatterns,
    },
  };
}
