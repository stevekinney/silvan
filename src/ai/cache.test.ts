import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import { appendUserMessage, createConversation } from 'conversationalist';
import { z } from 'zod';

import { configSchema } from '../config/schema';
import { writeAiCache } from './cache';
import { getCognitionModel, resolveCognitionProvider } from './cognition/policy';
import type { ConversationSnapshot } from './conversation/types';
import { invokeCognition } from './router';

describe('ai cache', () => {
  it('reuses cached results for identical inputs', async () => {
    Bun.env['ANTHROPIC_API_KEY'] = 'test';
    const config = configSchema.parse({});
    const provider = resolveCognitionProvider(config);
    const model = getCognitionModel(config, 'plan');

    const cacheDir = await mkdtemp(join(tmpdir(), 'silvan-ai-cache-'));
    const inputsDigest = 'inputs-digest';
    const schema = z.object({ summary: z.string() });
    await writeAiCache({
      cacheDir,
      key: {
        promptKind: 'plan',
        inputsDigest,
        provider: provider.provider,
        model,
      },
      content: { summary: 'cached' },
    });

    let called = false;
    const client = {
      chat: async () => {
        called = true;
        return { content: { summary: 'live' } };
      },
    };

    let conversation = createConversation({ title: 'cache' });
    conversation = appendUserMessage(conversation, 'hello');
    const snapshot: ConversationSnapshot = {
      conversation,
      digest: 'digest',
      updatedAt: new Date().toISOString(),
      path: 'memory',
    };

    const result = await invokeCognition({
      snapshot,
      task: 'plan',
      schema,
      config,
      client,
      cacheDir,
      inputsDigest,
    });

    expect(called).toBe(false);
    expect(result.summary).toBe('cached');

    await rm(cacheDir, { recursive: true, force: true });
  });
});
