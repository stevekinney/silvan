import { describe, expect, it } from 'bun:test';
import { getMessages } from 'conversationalist';

import { configSchema } from '../../config/schema';
import { SilvanError } from '../../core/errors';
import { setEnvValue, unsetEnvValue } from '../../utils/env';
import { suggestCliRecovery } from './assist';

const ORIGINAL_ANTHROPIC = Bun?.env?.['ANTHROPIC_API_KEY'];

function restoreAnthropicToken() {
  if (ORIGINAL_ANTHROPIC) {
    setEnvValue('ANTHROPIC_API_KEY', ORIGINAL_ANTHROPIC);
  } else {
    unsetEnvValue('ANTHROPIC_API_KEY');
  }
}

describe('assist recovery helpers', () => {
  it('sanitizes and deduplicates assist output', async () => {
    setEnvValue('ANTHROPIC_API_KEY', 'token');
    const config = configSchema.parse({});
    const error = new SilvanError({
      code: 'fail',
      message: 'Fail',
      userMessage: 'Fail',
      details: {
        token: 'secret',
        apiKey: 'secret',
        hint: 'keep',
      },
    });

    const suggestion = await suggestCliRecovery({
      error,
      command: 'silvan run',
      config,
      invoke: (async (
        options: Parameters<typeof import('../router').invokeCognition>[0],
      ) => {
        const { snapshot } = options;
        const user = getMessages(snapshot.conversation).find(
          (message) => message.role === 'user',
        );
        const content = typeof user?.content === 'string' ? user.content : '{}';
        const payload = JSON.parse(content) as {
          error?: { details?: Record<string, unknown> };
        };
        expect(payload.error?.details?.['token']).toBeUndefined();
        expect(payload.error?.details?.['apiKey']).toBeUndefined();
        return {
          summary: '  Summary  ',
          steps: ['Step', 'Step', 'Another'],
        };
      }) as unknown as typeof import('../router').invokeCognition,
    });

    restoreAnthropicToken();
    expect(suggestion?.summary).toBe('Summary');
    expect(suggestion?.steps).toEqual(['Step', 'Another']);
  });
});
