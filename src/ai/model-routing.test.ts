import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { configSchema } from '../config/schema';
import { createEnvelope } from '../events/emit';
import type { Event } from '../events/schema';
import { initStateStore } from '../state/store';
import { applyCognitionModelRouting, buildModelRoutingReport } from './model-routing';

function buildSessionEvent(options: {
  runId: string;
  repoRoot: string;
  model: string;
  ok: boolean;
  durationMs: number;
  task: 'plan';
}): Event {
  return createEnvelope({
    type: 'ai.session_finished',
    source: 'ai',
    level: 'info',
    context: { runId: options.runId, repoRoot: options.repoRoot },
    payload: {
      model: { provider: 'anthropic', model: options.model },
      task: options.task,
      ok: options.ok,
      durationMs: options.durationMs,
    },
  });
}

async function writeAuditLog(stateDir: string, runId: string, events: Event[]) {
  const payload = events.map((event) => JSON.stringify(event)).join('\n');
  await writeFile(join(stateDir, `${runId}.jsonl`), payload, 'utf8');
}

describe('model routing', () => {
  it('recommends a higher-success model within latency guardrail', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'silvan-routing-'));
    const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });

    const events: Event[] = [
      buildSessionEvent({
        runId: 'run-1',
        repoRoot,
        model: 'model-a',
        ok: true,
        durationMs: 1000,
        task: 'plan',
      }),
      buildSessionEvent({
        runId: 'run-2',
        repoRoot,
        model: 'model-a',
        ok: false,
        durationMs: 1000,
        task: 'plan',
      }),
      buildSessionEvent({
        runId: 'run-3',
        repoRoot,
        model: 'model-b',
        ok: true,
        durationMs: 1100,
        task: 'plan',
      }),
      buildSessionEvent({
        runId: 'run-4',
        repoRoot,
        model: 'model-b',
        ok: true,
        durationMs: 1100,
        task: 'plan',
      }),
    ];

    await writeAuditLog(state.auditDir, 'run-1', events);

    const config = configSchema.parse({
      ai: {
        models: { default: 'model-a' },
        cognition: {
          routing: {
            minSamples: 2,
            maxLatencyDelta: 0.2,
            lookbackDays: 30,
            autoApply: true,
            respectOverrides: true,
          },
        },
      },
    });

    const report = await buildModelRoutingReport({ state, config });
    expect(report.recommendations[0]?.recommendedModel).toBe('model-b');

    const decision = await applyCognitionModelRouting({
      state,
      config,
      runId: 'apply-1',
    });
    expect(decision.config.ai.cognition.modelByTask.plan).toBe('model-b');

    await rm(repoRoot, { recursive: true, force: true });
  });

  it('respects explicit model overrides when configured', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'silvan-routing-'));
    const state = await initStateStore(repoRoot, { lock: false, mode: 'repo' });

    const events: Event[] = [
      buildSessionEvent({
        runId: 'run-1',
        repoRoot,
        model: 'model-a',
        ok: true,
        durationMs: 1000,
        task: 'plan',
      }),
      buildSessionEvent({
        runId: 'run-2',
        repoRoot,
        model: 'model-b',
        ok: true,
        durationMs: 900,
        task: 'plan',
      }),
    ];

    await writeAuditLog(state.auditDir, 'run-1', events);

    const config = configSchema.parse({
      ai: {
        models: { default: 'model-a' },
        cognition: {
          routing: {
            minSamples: 1,
            maxLatencyDelta: 0.2,
            lookbackDays: 30,
            autoApply: true,
            respectOverrides: true,
          },
          modelByTask: { plan: 'model-a' },
        },
      },
    });

    const decision = await applyCognitionModelRouting({
      state,
      config,
      runId: 'apply-2',
    });
    expect(decision.config.ai.cognition.modelByTask.plan).toBe('model-a');

    await rm(repoRoot, { recursive: true, force: true });
  });
});
