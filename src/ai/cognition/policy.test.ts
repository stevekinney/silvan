import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { configSchema } from '../../config/schema';
import { readEnvValue, setEnvValue, unsetEnvValue } from '../../utils/env';
import { resolveCognitionProvider } from './policy';

type ProviderCase = {
  provider: 'anthropic' | 'openai' | 'gemini';
  envKey: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY';
  value: string;
};

const providerCases: ProviderCase[] = [
  { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', value: 'anthropic-token' },
  { provider: 'openai', envKey: 'OPENAI_API_KEY', value: 'openai-token' },
  { provider: 'gemini', envKey: 'GEMINI_API_KEY', value: 'gemini-token' },
];

describe('resolveCognitionProvider', () => {
  const envSnapshot = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const { envKey } of providerCases) {
      envSnapshot.set(envKey, readEnvValue(envKey));
      unsetEnvValue(envKey);
    }
  });

  afterEach(() => {
    for (const { envKey } of providerCases) {
      const value = envSnapshot.get(envKey);
      if (value) {
        setEnvValue(envKey, value);
      } else {
        unsetEnvValue(envKey);
      }
    }
  });

  it('reads cognition API keys from the environment', () => {
    for (const entry of providerCases) {
      setEnvValue(entry.envKey, entry.value);
      const config = configSchema.parse({
        ai: { cognition: { provider: entry.provider } },
      });
      const resolved = resolveCognitionProvider(config);
      expect(resolved.provider).toBe(entry.provider);
      expect(resolved.apiKey).toBe(entry.value);
      unsetEnvValue(entry.envKey);
    }
  });

  it('throws when the provider key is missing', () => {
    const config = configSchema.parse({ ai: { cognition: { provider: 'openai' } } });
    expect(() => resolveCognitionProvider(config)).toThrow(
      'Missing API key for cognition provider: openai',
    );
  });
});
