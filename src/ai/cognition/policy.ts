import type { Config } from '../../config/schema';
import { readEnvValue } from '../../utils/env';
import type { CognitionTask } from '../router';

const fallbackModel = 'claude-3-5-haiku-latest';

export function getCognitionModel(config: Config, task: CognitionTask): string {
  const modelByTask = config.ai.cognition.modelByTask;
  return (
    modelByTask[task] ??
    config.ai.models.plan ??
    config.ai.models.default ??
    fallbackModel
  );
}

export function resolveCognitionProvider(config: Config): {
  provider: Config['ai']['cognition']['provider'];
  apiKey: string;
} {
  const provider = config.ai.cognition.provider;
  const apiKey =
    provider === 'openai'
      ? readEnvValue('OPENAI_API_KEY')
      : provider === 'gemini'
        ? readEnvValue('GEMINI_API_KEY')
        : readEnvValue('ANTHROPIC_API_KEY');

  if (!apiKey) {
    throw new Error(`Missing API key for cognition provider: ${provider}`);
  }

  return { provider, apiKey };
}
