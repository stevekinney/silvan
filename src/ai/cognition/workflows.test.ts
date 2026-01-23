import { describe, expect, it } from 'bun:test';
import { appendMessages, createConversation } from 'conversationalist';
import type { ZodSchema } from 'zod';

import type { ReviewClassification } from '../../agent/schemas';
import { configSchema } from '../../config/schema';
import { EventBus } from '../../events/bus';
import { setEnvValue, unsetEnvValue } from '../../utils/env';
import type { ConversationStore } from '../conversation/types';
import { generateCiFixPlan } from './ci-triager';
import { generatePlan } from './planner';
import { draftPullRequest } from './pr-writer';
import { generateRecoveryPlan } from './recovery';
import { classifyReviewThreads } from './review-classifier';
import { generateReviewFixPlan } from './reviewer';
import { summarizeConversation } from './summarize';
import { generateVerificationFixPlan } from './verification-fix';
import { decideVerification } from './verifier';

function createMemoryStore(): ConversationStore {
  let conversation = createConversation({ title: 'AI' });
  const snapshot = async (value = conversation) => ({
    conversation: value,
    digest: 'digest',
    updatedAt: new Date().toISOString(),
    path: 'memory',
  });
  const metrics = () => ({
    beforeMessages: conversation.ids.length,
    afterMessages: conversation.ids.length,
    beforeTokens: 0,
    afterTokens: 0,
    tokensSaved: 0,
    compressionRatio: 1,
    summaryAdded: false,
    changed: false,
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
    optimize: async () => {
      const snap = await snapshot();
      return { conversation: snap.conversation, snapshot: snap, metrics: metrics() };
    },
  };
}

function createChatClient<T>(content: T) {
  return {
    chat: async (_options: { messages: unknown; schema: ZodSchema<T> }) => ({
      content,
    }),
  };
}

const ORIGINAL_ANTHROPIC = Bun?.env?.['ANTHROPIC_API_KEY'];

function restoreAnthropicToken() {
  if (ORIGINAL_ANTHROPIC) {
    setEnvValue('ANTHROPIC_API_KEY', ORIGINAL_ANTHROPIC);
  } else {
    unsetEnvValue('ANTHROPIC_API_KEY');
  }
}

describe('cognition workflows', () => {
  it('summarizes conversations', async () => {
    const config = configSchema.parse({});
    const summary = await summarizeConversation({
      snapshot: await createMemoryStore().snapshot(),
      config,
      invoke: (async () => ({
        summary: 'Short summary',
      })) as unknown as typeof import('../router').invokeCognition,
    });
    expect(summary).toBe('Short summary');
  });

  it('generates a plan with a stubbed model', async () => {
    const config = configSchema.parse({});
    const plan = await generatePlan({
      repoRoot: process.cwd(),
      store: createMemoryStore(),
      config,
      invoke: (async () => ({
        summary: 'Plan',
        steps: [{ id: '1', title: 'Step', description: 'Do it' }],
        verification: ['bun test'],
      })) as unknown as typeof import('../router').invokeCognition,
    });
    expect(plan.summary).toBe('Plan');
  });

  it('generates CI fix plans and validates schema', async () => {
    const config = configSchema.parse({});
    setEnvValue('ANTHROPIC_API_KEY', 'token');
    const events: Array<{ type: string }> = [];
    const bus = new EventBus();
    const unsub = bus.subscribe((event) => {
      events.push(event);
    });
    const plan = await generateCiFixPlan({
      ci: { state: 'failing' },
      store: createMemoryStore(),
      config,
      invoke: (async () => ({
        summary: 'Fix',
        steps: [{ id: '1', title: 'Step', description: 'Do it' }],
        verification: ['bun test'],
      })) as unknown as typeof import('../router').invokeCognition,
      bus,
      context: { runId: 'run-1', repoRoot: '/tmp' },
    });
    unsub();
    restoreAnthropicToken();
    expect(plan.summary).toBe('Fix');
    expect(events.length).toBeGreaterThan(0);
  });

  it('generates recovery plans', async () => {
    const config = configSchema.parse({});
    const plan = await generateRecoveryPlan({
      runState: { status: 'failed' },
      store: createMemoryStore(),
      config,
      invoke: (async () => ({
        nextAction: 'ask_user',
        reason: 'Need input',
      })) as unknown as typeof import('../router').invokeCognition,
    });
    expect(plan.nextAction).toBe('ask_user');
  });

  it('drafts pull requests', async () => {
    const config = configSchema.parse({});
    const draft = await draftPullRequest({
      planSummary: 'Plan',
      changesSummary: 'Changes',
      store: createMemoryStore(),
      config,
      invoke: (async () => ({
        title: 'PR',
        body: 'Body',
      })) as unknown as typeof import('../router').invokeCognition,
    });
    expect(draft.title).toBe('PR');
  });

  it('decides verification commands', async () => {
    const config = configSchema.parse({});
    const decision = await decideVerification({
      report: { ok: false, results: [] },
      store: createMemoryStore(),
      config,
      invoke: (async () => ({
        commands: ['bun test'],
        rationale: 'Run tests',
      })) as unknown as typeof import('../router').invokeCognition,
      context: { runId: 'run-2', repoRoot: '/tmp' },
    });
    expect(decision.commands).toEqual(['bun test']);
  });

  it('builds verification fix plans', async () => {
    const config = configSchema.parse({});
    const plan = await generateVerificationFixPlan({
      failures: [
        { name: 'lint', exitCode: 1, stderr: 'lint failed', command: 'bun run lint' },
      ],
      store: createMemoryStore(),
      config,
      invoke: (async () => ({
        summary: 'Fix lint',
        steps: [{ id: '1', title: 'Fix lint', description: 'Update lint errors' }],
        verification: ['bun run lint'],
      })) as unknown as typeof import('../router').invokeCognition,
      context: { runId: 'run-3', repoRoot: '/tmp' },
    });
    expect(plan.summary).toBe('Fix lint');
  });

  it('classifies review threads', async () => {
    const config = configSchema.parse({});
    setEnvValue('ANTHROPIC_API_KEY', 'token');
    const result = await classifyReviewThreads({
      threads: [],
      store: createMemoryStore(),
      config,
      client: createChatClient<ReviewClassification>({
        actionableThreadIds: [] as string[],
        ignoredThreadIds: [] as string[],
        needsContextThreadIds: [] as string[],
        threads: [],
      }),
    });
    restoreAnthropicToken();
    expect(result.actionableThreadIds).toEqual([]);
  });

  it('builds review fix plans', async () => {
    const config = configSchema.parse({});
    setEnvValue('ANTHROPIC_API_KEY', 'token');
    const plan = await generateReviewFixPlan({
      threads: [
        {
          threadId: 't1',
          comments: [{ id: 'c1', bodyDigest: 'hash', path: null, line: null }],
          isOutdated: false,
        },
      ],
      store: createMemoryStore(),
      config,
      client: createChatClient({
        threads: [
          {
            threadId: 't1',
            actionable: true as boolean,
            summary: 'Fix it',
            comments: [{ id: 'c1', action: 'Update' }],
          },
        ],
      }),
    });
    restoreAnthropicToken();
    expect(plan.threads[0]?.summary).toBe('Fix it');
  });
});
