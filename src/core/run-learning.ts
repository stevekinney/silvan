import { planSchema } from '../agent/schemas';
import { createConversationStore } from '../ai/conversation';
import { runGit } from '../git/exec';
import {
  evaluateLearningTargets,
  loadLearningHistory,
  scoreLearningConfidence,
} from '../learning/auto-apply';
import {
  applyLearningNotes,
  generateLearningNotes,
  renderLearningMarkdown,
} from '../learning/notes';
import { readArtifact } from '../state/artifacts';
import { type LearningRequest, writeLearningRequest } from '../state/learning';
import type { Task } from '../task/types';
import { hashString } from '../utils/hash';
import type { RunContext } from './context';
import {
  commitLearningNotes,
  getArtifactEntry,
  getRunState,
  getStepRecord,
  recordArtifacts,
  runStep,
  updateState,
} from './run-helpers';

export async function runLearningNotes(
  ctx: RunContext,
  options?: { allowApply?: boolean },
): Promise<void> {
  const config = ctx.config.learning;
  if (!config.enabled) return;

  const state = await ctx.state.readRunState(ctx.runId);
  const data = getRunState((state?.data as Record<string, unknown>) ?? {});
  const emitContext = {
    runId: ctx.runId,
    repoRoot: ctx.repo.repoRoot,
    mode: ctx.events.mode,
  };
  const worktreeRoot = ctx.repo.worktreePath ?? ctx.repo.repoRoot;
  const conversationStore = createConversationStore({
    runId: ctx.runId,
    state: ctx.state,
    config: ctx.config,
    bus: ctx.events.bus,
    context: emitContext,
  });

  const task = data['task'] as Task | undefined;
  const planResult = planSchema.safeParse(data['plan']);
  const planSummary =
    planResult.success && planResult.data.summary ? planResult.data.summary : undefined;
  const summary =
    typeof data['summary'] === 'object' && data['summary']
      ? (data['summary'] as Record<string, unknown>)
      : {};
  const input = {
    ...(task
      ? { task: { key: task.key, title: task.title, provider: task.provider } }
      : {}),
    ...(planSummary ? { planSummary } : {}),
    ...(typeof data['implementationSummary'] === 'string'
      ? { implementationSummary: data['implementationSummary'] }
      : {}),
    ...(typeof data['verifySummary'] === 'object' && data['verifySummary']
      ? { verification: data['verifySummary'] as { ok?: boolean } }
      : {}),
    ...(typeof data['localGateSummary'] === 'object' && data['localGateSummary']
      ? { localGate: data['localGateSummary'] as { ok?: boolean } }
      : {}),
    ...(typeof data['reviewClassificationSummary'] === 'object' &&
    data['reviewClassificationSummary']
      ? {
          review: {
            unresolved:
              typeof summary['unresolvedReviewCount'] === 'number'
                ? summary['unresolvedReviewCount']
                : 0,
            actionable: (data['reviewClassificationSummary'] as { actionable?: number })
              .actionable,
          },
        }
      : {}),
    ...(typeof data['ciFixSummary'] === 'object' && data['ciFixSummary']
      ? { ciFixSummary: data['ciFixSummary'] as { summary?: string } }
      : {}),
    ...(typeof summary['blockedReason'] === 'string'
      ? { blockedReason: summary['blockedReason'] }
      : {}),
    ...(typeof summary['prUrl'] === 'string' ? { pr: { url: summary['prUrl'] } } : {}),
  } as import('../learning/notes').LearningInput;

  const baseBranch = ctx.config.github.baseBranch ?? ctx.config.repo.defaultBranch;
  const diffStat = await runGit(['diff', '--stat', `${baseBranch}...HEAD`], {
    cwd: worktreeRoot,
    bus: ctx.events.bus,
    context: emitContext,
  });
  if (diffStat.stdout.trim()) {
    input.diffStat = diffStat.stdout.trim();
  }

  const notesStep = getStepRecord(data, 'learning.notes');
  const existingDataEntry = getArtifactEntry(data, 'learning.notes', 'data');
  const existingNotes =
    notesStep?.status === 'done' && existingDataEntry
      ? await readArtifact<import('../learning/notes').LearningNotes>({
          entry: existingDataEntry,
        })
      : undefined;

  const notes =
    existingNotes ??
    (await runStep(
      ctx,
      'learning.notes',
      'Generate learning notes',
      () =>
        generateLearningNotes({
          input,
          store: conversationStore,
          config: ctx.config,
          cacheDir: ctx.state.cacheDir,
          bus: ctx.events.bus,
          context: emitContext,
        }),
      {
        inputs: { digest: hashString(JSON.stringify(input)) },
        artifacts: (result) => ({ data: result }),
      },
    ));

  const markdown = renderLearningMarkdown(ctx.runId, input, notes);
  const notesEntry = getArtifactEntry(data, 'learning.notes', 'notes');
  if (!notesEntry) {
    await recordArtifacts(ctx, 'learning.notes', {
      notes: markdown,
    });
  }

  const allowApply = options?.allowApply ?? true;
  const applyTargets = {
    ...(config.targets.rules ? { rules: config.targets.rules } : {}),
    ...(config.targets.skills ? { skills: config.targets.skills } : {}),
    ...(config.targets.docs ? { docs: config.targets.docs } : {}),
  };
  const targetCheck = evaluateLearningTargets({
    targets: applyTargets,
    worktreeRoot,
  });
  const hasItems = notes.rules.length + notes.skills.length + notes.docs.length > 0;
  const baseSummary = {
    summary: notes.summary,
    rules: notes.rules.length,
    skills: notes.skills.length,
    docs: notes.docs.length,
    mode: config.mode,
  };
  const updateLearningSummary = async (extra?: Record<string, unknown>) =>
    updateState(ctx, (prev) => ({
      ...prev,
      learningSummary: {
        ...(typeof prev['learningSummary'] === 'object' && prev['learningSummary']
          ? (prev['learningSummary'] as Record<string, unknown>)
          : {}),
        ...baseSummary,
        ...(extra ?? {}),
      },
    }));

  if (!hasItems) {
    await updateLearningSummary({ status: 'skipped', reason: 'no_items' });
    return;
  }

  const autoApplyConfig = config.autoApply;
  const shouldScore = autoApplyConfig.enabled;
  const shouldAutoApply = config.mode !== 'apply' && autoApplyConfig.enabled;
  const shouldApplyImmediately = config.mode === 'apply';
  const ciState = summary['ci'] as import('../events/schema').CiState | undefined;
  const unresolvedReviews =
    typeof summary['unresolvedReviewCount'] === 'number'
      ? summary['unresolvedReviewCount']
      : undefined;
  const aiReviewSummary = data['aiReviewSummary'] as { shipIt?: boolean } | undefined;

  const confidenceResult = shouldScore
    ? scoreLearningConfidence({
        notes,
        history: await loadLearningHistory({
          state: ctx.state,
          excludeRunId: ctx.runId,
          lookbackDays: autoApplyConfig.lookbackDays,
          maxEntries: autoApplyConfig.maxHistory,
        }),
        minSamples: autoApplyConfig.minSamples,
        threshold: autoApplyConfig.threshold,
        ...(ciState ? { ci: ciState } : {}),
        ...(typeof unresolvedReviews === 'number' ? { unresolvedReviews } : {}),
        ...(typeof aiReviewSummary?.shipIt === 'boolean'
          ? { aiReviewShipIt: aiReviewSummary.shipIt }
          : {}),
      })
    : undefined;

  if (shouldApplyImmediately) {
    if (!allowApply) {
      const request: LearningRequest = {
        id: ctx.runId,
        runId: ctx.runId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        summary: notes.summary,
        confidence: confidenceResult?.confidence ?? 0,
        threshold: confidenceResult?.threshold ?? autoApplyConfig.threshold,
        notes,
        targets: applyTargets,
        reason: 'apply_disabled',
      };
      await writeLearningRequest({ state: ctx.state, request });
      await updateLearningSummary({
        status: 'pending',
        confidence: request.confidence,
        threshold: request.threshold,
        decisionReason: request.reason,
      });
      return;
    }

    if (!targetCheck.ok) {
      const request: LearningRequest = {
        id: ctx.runId,
        runId: ctx.runId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        summary: notes.summary,
        confidence: confidenceResult?.confidence ?? 0,
        threshold: confidenceResult?.threshold ?? autoApplyConfig.threshold,
        notes,
        targets: applyTargets,
        reason: `unsafe_targets: ${targetCheck.reasons.join('; ')}`,
      };
      await writeLearningRequest({ state: ctx.state, request });
      await updateLearningSummary({
        status: 'pending',
        confidence: request.confidence,
        threshold: request.threshold,
        decisionReason: request.reason,
      });
      return;
    }

    const applyStep = getStepRecord(data, 'learning.apply');
    if (applyStep?.status !== 'done') {
      const applyResult = await runStep(
        ctx,
        'learning.apply',
        'Apply learning updates',
        () =>
          applyLearningNotes({
            runId: ctx.runId,
            worktreeRoot,
            notes,
            targets: applyTargets,
          }),
        { artifacts: (result) => ({ result }) },
      );
      const commitResult = await commitLearningNotes({
        ctx,
        worktreeRoot,
        runId: ctx.runId,
        appliedTo: applyResult.appliedTo,
        message: `silvan: apply learnings (${ctx.runId})`,
      });
      const appliedAt = new Date().toISOString();
      await updateLearningSummary({
        status: 'applied',
        appliedTo: applyResult.appliedTo,
        appliedAt,
        commitSha: commitResult.sha,
        autoApplied: true,
      });
      await writeLearningRequest({
        state: ctx.state,
        request: {
          id: ctx.runId,
          runId: ctx.runId,
          status: 'applied',
          createdAt: appliedAt,
          updatedAt: appliedAt,
          summary: notes.summary,
          confidence: confidenceResult?.confidence ?? 1,
          threshold: confidenceResult?.threshold ?? autoApplyConfig.threshold,
          notes,
          targets: applyTargets,
          appliedAt,
          appliedTo: applyResult.appliedTo,
          ...(commitResult.sha ? { commitSha: commitResult.sha } : {}),
          reason: 'mode_apply',
        },
      });
    }
    return;
  }

  if (!shouldAutoApply) {
    await updateLearningSummary({ status: 'recorded' });
    return;
  }

  const confidence = confidenceResult?.confidence ?? 0;
  const threshold = confidenceResult?.threshold ?? autoApplyConfig.threshold;
  const belowThreshold = confidence < threshold;
  const applyBlockedReason = !allowApply
    ? 'apply_disabled'
    : !targetCheck.ok
      ? `unsafe_targets: ${targetCheck.reasons.join('; ')}`
      : belowThreshold
        ? 'below_threshold'
        : undefined;

  if (applyBlockedReason) {
    const request: LearningRequest = {
      id: ctx.runId,
      runId: ctx.runId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      summary: notes.summary,
      confidence,
      threshold,
      notes,
      targets: applyTargets,
      reason: applyBlockedReason,
    };
    await writeLearningRequest({ state: ctx.state, request });
    await updateLearningSummary({
      status: 'pending',
      confidence,
      threshold,
      decisionReason: applyBlockedReason,
      ...(confidenceResult?.breakdown
        ? { confidenceBreakdown: confidenceResult.breakdown }
        : {}),
    });
    return;
  }

  const autoApplyStep = getStepRecord(data, 'learning.auto_apply');
  if (autoApplyStep?.status === 'done') {
    await updateLearningSummary({
      status: 'applied',
      confidence,
      threshold,
      autoApplied: true,
      ...(confidenceResult?.breakdown
        ? { confidenceBreakdown: confidenceResult.breakdown }
        : {}),
    });
    return;
  }

  const applyResult = await runStep(
    ctx,
    'learning.auto_apply',
    'Auto-apply learning updates',
    () =>
      applyLearningNotes({
        runId: ctx.runId,
        worktreeRoot,
        notes,
        targets: applyTargets,
      }),
    { artifacts: (result) => ({ result }) },
  );
  const commitResult = await commitLearningNotes({
    ctx,
    worktreeRoot,
    runId: ctx.runId,
    appliedTo: applyResult.appliedTo,
    message: `silvan: apply learnings (${ctx.runId})`,
  });
  const appliedAt = new Date().toISOString();
  await updateLearningSummary({
    status: 'applied',
    appliedTo: applyResult.appliedTo,
    appliedAt,
    commitSha: commitResult.sha,
    autoApplied: true,
    confidence,
    threshold,
    ...(confidenceResult?.breakdown
      ? { confidenceBreakdown: confidenceResult.breakdown }
      : {}),
  });
  await writeLearningRequest({
    state: ctx.state,
    request: {
      id: ctx.runId,
      runId: ctx.runId,
      status: 'applied',
      createdAt: appliedAt,
      updatedAt: appliedAt,
      summary: notes.summary,
      confidence,
      threshold,
      notes,
      targets: applyTargets,
      appliedAt,
      appliedTo: applyResult.appliedTo,
      ...(commitResult.sha ? { commitSha: commitResult.sha } : {}),
      reason: 'auto_apply',
    },
  });
}
