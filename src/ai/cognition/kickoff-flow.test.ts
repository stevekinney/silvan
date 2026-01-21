import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import { appendMessages, createConversation } from 'conversationalist';

import { configSchema } from '../../config/schema';
import type { ConversationStore } from '../conversation/types';
import { generateExecutionKickoffPrompt } from './kickoff';
import { generateReviewRemediationKickoffPrompt } from './review-kickoff';

function createMemoryStore(): ConversationStore {
  let conversation = createConversation({ title: 'Kickoff' });
  const snapshot = async (value = conversation) => ({
    conversation: value,
    digest: 'digest',
    updatedAt: new Date().toISOString(),
    path: 'memory',
  });
  return {
    load: async () => conversation,
    save: async (next) => {
      conversation = next;
      return snapshot(conversation);
    },
    append: async (messages) => {
      const list = Array.isArray(messages) ? messages : [messages];
      conversation = appendMessages(conversation, ...list);
      return snapshot(conversation);
    },
    snapshot,
  };
}

describe('kickoff prompt flows', () => {
  it('builds execution kickoff prompts with fallback content', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'silvan-kickoff-'));
    try {
      await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ name: 'demo' }));
      const config = configSchema.parse({});
      const task = {
        id: 'task-1',
        provider: 'local' as const,
        title: 'Do work',
        description: 'Desc',
        acceptanceCriteria: ['Pass'],
        labels: [],
      };
      const prompt = await generateExecutionKickoffPrompt({
        task,
        repoRoot,
        store: createMemoryStore(),
        config,
        invoke: (async () =>
          null) as unknown as typeof import('../router').invokeCognition,
      });
      expect(prompt.body.objective).toContain('Do work');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('builds review remediation prompts with fallback content', async () => {
    const config = configSchema.parse({});
    const prompt = await generateReviewRemediationKickoffPrompt({
      task: {
        id: 'task-2',
        provider: 'local',
        title: 'Fix review',
        description: 'Desc',
        acceptanceCriteria: [],
        labels: [],
      },
      pr: { id: 'acme/repo#1', branch: 'feat' },
      review: { unresolvedThreadCount: 1, threadFingerprints: [] },
      ci: { state: 'unknown', failedChecks: [] },
      repo: { frameworks: [], verificationCommands: [] },
      store: createMemoryStore(),
      config,
      invoke: (async () => null) as unknown as typeof import('../router').invokeCognition,
    });
    expect(prompt.body.objective).toContain('Fix review');
  });
});
