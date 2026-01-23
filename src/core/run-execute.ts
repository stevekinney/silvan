import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import { executePlan } from '../agent/executor';
import { planSchema } from '../agent/schemas';
import { draftPullRequest } from '../ai/cognition/pr-writer';
import { decideVerification } from '../ai/cognition/verifier';
import { createConversationStore } from '../ai/conversation';
import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import { runGit } from '../git/exec';
import { waitForCi } from '../github/ci';
import { openOrUpdatePr, requestReviewers } from '../github/pr';
import { runAiReviewer } from '../review/ai-reviewer';
import { formatLocalGateSummary, generateLocalGateReport } from '../review/local-gate';
import { suggestReviewers } from '../review/reviewer-suggestions';
import { readArtifact } from '../state/artifacts';
import { readReviewerStats, recordReviewerRequests } from '../state/reviewers';
import {
  commentOnPrOpen,
  moveTaskToInProgress,
  moveTaskToInReview,
} from '../task/lifecycle';
import type { Task } from '../task/types';
import { hashString } from '../utils/hash';
import { runVerifyCommands } from '../verify/run';
import { triageVerificationFailures } from '../verify/triage';
import type { RunContext } from './context';
import {
  attemptVerificationAutoFix,
  changePhase,
  createCheckpointCommit,
  getArtifactEntry,
  getBudgetsForPhase,
  getModelForPhase,
  getRunState,
  getStepRecord,
  getToolBudget,
  heartbeatStep,
  recordVerificationAssist,
  reviewRequestKey,
  type RunControllerOptions,
  runStep,
  updateState,
} from './run-helpers';

export async function runImplementation(
  ctx: RunContext,
  options: RunControllerOptions,
): Promise<boolean> {
  const state = await ctx.state.readRunState(ctx.runId);
  const data = getRunState((state?.data as Record<string, unknown>) ?? {});
  const planResult = planSchema.safeParse(data['plan']);
  if (!planResult.success) {
    throw new Error('No plan found in run state. Run agent plan first.');
  }
  const plan = planResult.data;
  const clarifications =
    typeof data['clarifications'] === 'object' && data['clarifications']
      ? (data['clarifications'] as Record<string, string>)
      : {};
  const missingClarifications = plan.questions?.filter((question) => {
    const answer = clarifications[question.id];
    return question.required !== false && (!answer || answer.trim() === '');
  });
  if (missingClarifications && missingClarifications.length > 0) {
    throw new Error('Clarifications required before execution.');
  }

  await changePhase(ctx, 'implement');
  const execModel = getModelForPhase(ctx.config, 'execute');
  const execBudgets = getBudgetsForPhase(ctx.config, 'execute');
  const worktreeRoot = ctx.repo.worktreePath ?? ctx.repo.repoRoot;
  const task = (data['task'] as Task | undefined) ?? undefined;
  const emitContext = {
    runId: ctx.runId,
    repoRoot: ctx.repo.repoRoot,
    mode: ctx.events.mode,
    ...(task ? { taskId: task.id } : {}),
  };
  const conversationStore = createConversationStore({
    runId: ctx.runId,
    state: ctx.state,
    config: ctx.config,
    bus: ctx.events.bus,
    context: emitContext,
  });
  if (task) {
    const moveStep = getStepRecord(data, 'task.move_in_progress');
    if (moveStep?.status !== 'done') {
      await runStep(ctx, 'task.move_in_progress', 'Move task to In Progress', () =>
        moveTaskToInProgress(task, ctx.config),
      );
    }
  }
  const toolCallLog: Array<{
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    resultDigest?: string;
    ok: boolean;
  }> = [];
  const execStep = getStepRecord(data, 'agent.execute');
  const existingSummary =
    typeof data['implementationSummary'] === 'string'
      ? data['implementationSummary']
      : undefined;
  const planDigest = hashString(JSON.stringify(plan));
  const summary =
    execStep?.status === 'done' && existingSummary
      ? existingSummary
      : await runStep(
          ctx,
          'agent.execute',
          'Execute plan',
          async () => {
            const execPrompt = new ProseWriter();
            execPrompt.write('You are the implementation agent for Silvan.');
            execPrompt.write('Follow the plan step-by-step, using tools when needed.');
            execPrompt.write('Do not invent file contents; use fs.read before edits.');
            execPrompt.write('Keep changes minimal and aligned to the plan.');
            execPrompt.write(
              'Use silvan.plan.read to fetch the full plan before making edits.',
            );
            execPrompt.write('Use silvan.task.read to fetch the task details as needed.');
            execPrompt.write('Return a brief summary of changes.');
            execPrompt.write(`Plan digest: ${planDigest}`);

            const execSnapshot = await conversationStore.append({
              role: 'system',
              content: execPrompt.toString().trimEnd(),
              metadata: { kind: 'plan' },
            });

            const result = await executePlan({
              snapshot: execSnapshot,
              model: execModel,
              repoRoot: worktreeRoot,
              config: ctx.config,
              dryRun: Boolean(options.dryRun),
              allowDestructive: Boolean(options.apply),
              allowDangerous: Boolean(options.dangerous),
              ...(options.sessions ? { sessionPool: options.sessions } : {}),
              bus: ctx.events.bus,
              context: emitContext,
              state: ctx.state,
              ...execBudgets,
              ...getToolBudget(ctx.config),
              heartbeat: () => heartbeatStep(ctx, 'agent.execute'),
              toolCallLog,
            });

            const execConversation = appendMessages(execSnapshot.conversation, {
              role: 'assistant',
              content: `Implementation summary: ${result}`,
              metadata: { kind: 'plan', protected: true },
            });
            await conversationStore.save(execConversation);
            return result;
          },
          {
            inputs: { planDigest },
            artifacts: () => ({ toolCalls: toolCallLog }),
          },
        );

  await updateState(ctx, (data) => ({
    ...data,
    implementationSummary: summary,
    toolCallSummary: {
      total: toolCallLog.length,
      failed: toolCallLog.filter((call) => !call.ok).length,
    },
  }));

  const implementationCheckpoint = await runStep(
    ctx,
    'git.checkpoint',
    'Checkpoint implementation',
    () => createCheckpointCommit(ctx, 'silvan: checkpoint implement'),
    {
      inputs: { phase: 'implement' },
      artifacts: (result) => ({ checkpoint: result }),
    },
  );
  if (implementationCheckpoint?.sha) {
    await updateState(ctx, (data) => ({
      ...data,
      checkpoints: [
        ...((data['checkpoints'] as string[]) ?? []),
        implementationCheckpoint.sha,
      ],
    }));
  }

  await changePhase(ctx, 'verify');
  const verifyStep = getStepRecord(data, 'verify.run');
  const existingVerify = data['verifySummary'];
  let verifyReport =
    verifyStep?.status === 'done' &&
    typeof existingVerify === 'object' &&
    existingVerify &&
    (existingVerify as { ok?: boolean }).ok === true
      ? { ok: true, results: [] }
      : await runStep(
          ctx,
          'verify.run',
          'Run verification',
          () => runVerifyCommands(ctx.config, { cwd: worktreeRoot }),
          {
            artifacts: (report) => ({ report }),
          },
        );
  await updateState(ctx, (data) => ({
    ...data,
    verifySummary: {
      ok: verifyReport.ok,
      lastRunAt: new Date().toISOString(),
    },
  }));

  if (!verifyReport.ok) {
    await recordVerificationAssist({
      ctx,
      report: verifyReport,
      context: 'verify',
      emitContext,
    });
    const results = (
      verifyReport.results as Array<{
        name: string;
        exitCode: number;
        stderr: string;
      }>
    ).map((result) => ({
      name: result.name,
      exitCode: result.exitCode,
      stderr: result.stderr,
    }));

    let failedResults = results.filter((result) => result.exitCode !== 0);
    let triage = triageVerificationFailures(failedResults);
    const autoFixOutcome = await attemptVerificationAutoFix({
      ctx,
      emitContext,
      conversationStore,
      worktreeRoot,
      failures: failedResults,
      triageClassified: triage.classified,
      controllerOptions: options,
      context: 'verify',
    });
    if (autoFixOutcome.report) {
      verifyReport = autoFixOutcome.report;
      if (!verifyReport.ok) {
        const retryResults = (
          verifyReport.results as Array<{
            name: string;
            exitCode: number;
            stderr: string;
          }>
        )
          .filter((result) => result.exitCode !== 0)
          .map((result) => ({
            name: result.name,
            exitCode: result.exitCode,
            stderr: result.stderr,
          }));
        failedResults = retryResults;
        triage = triageVerificationFailures(failedResults);
        await recordVerificationAssist({
          ctx,
          report: verifyReport,
          context: 'verify',
          emitContext,
        });
      }
    }
    if (!autoFixOutcome.resolved) {
      const decision = await runStep(
        ctx,
        'verify.decide',
        'Decide verification next steps',
        async () => {
          if (options.apply && !triage.classified) {
            return decideVerification({
              report: {
                ok: verifyReport.ok,
                results: failedResults,
              },
              store: conversationStore,
              config: ctx.config,
              ...(ctx.events.bus ? { bus: ctx.events.bus } : {}),
              context: emitContext,
            });
          }
          return triage.decision;
        },
        {
          inputs: {
            classified: triage.classified,
            commandCount: failedResults.length,
          },
          artifacts: (result) => ({ decision: result }),
        },
      );

      await updateState(ctx, (data) => ({
        ...data,
        verificationDecisionSummary: {
          commands: decision.commands,
          askUser: decision.askUser ?? false,
        },
      }));
      throw new Error('Verification failed');
    }
  }

  const localGateConfig = ctx.config.review.localGate;
  const gateBaseBranch = ctx.config.github.baseBranch ?? ctx.config.repo.defaultBranch;
  const localGateRunWhen = localGateConfig.runWhen;
  const shouldRunLocalGateBeforePr =
    localGateConfig.enabled &&
    (localGateRunWhen === 'beforePrOpen' || localGateRunWhen === 'both');
  const localGateStep = getStepRecord(data, 'review.local_gate');
  const existingLocalGateEntry = getArtifactEntry(data, 'review.local_gate', 'report');
  let localGateReport =
    localGateStep?.status === 'done' && existingLocalGateEntry
      ? await readArtifact<import('../review/local-gate').LocalGateReport>({
          entry: existingLocalGateEntry,
        })
      : undefined;

  if (shouldRunLocalGateBeforePr && !localGateReport) {
    localGateReport = await runStep(
      ctx,
      'review.local_gate',
      'Run local review gate',
      () =>
        generateLocalGateReport({
          repoRoot: ctx.repo.repoRoot,
          baseBranch: gateBaseBranch,
          branchName: ctx.repo.branch,
          ...(ctx.repo.worktreePath ? { worktreePath: ctx.repo.worktreePath } : {}),
          config: ctx.config,
          state: ctx.state,
          runId: ctx.runId,
          bus: ctx.events.bus,
          context: emitContext,
        }),
      {
        artifacts: (report) => ({ report }),
      },
    );

    const blockers = localGateReport.findings.filter(
      (finding) => finding.severity === 'blocker',
    ).length;
    const warnings = localGateReport.findings.filter(
      (finding) => finding.severity === 'warn',
    ).length;

    await updateState(ctx, (data) => ({
      ...data,
      localGateSummary: {
        ok: localGateReport?.ok ?? false,
        blockers,
        warnings,
        generatedAt: localGateReport?.generatedAt,
      },
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary']
          ? data['summary']
          : {}),
        ...(localGateReport
          ? { localGate: formatLocalGateSummary(localGateReport) }
          : {}),
      },
    }));

    if (!localGateReport.ok && localGateConfig.blockPrOnFail) {
      await updateState(ctx, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          blockedReason: 'Local review gate failed.',
        },
      }));
      throw new Error('Local review gate failed');
    }
  }

  await changePhase(ctx, 'pr');
  let githubToken: string | undefined;
  let githubConfig: { owner: string; repo: string };
  try {
    githubToken = requireGitHubAuth(ctx.config);
    githubConfig = await requireGitHubConfig({
      config: ctx.config,
      repoRoot: ctx.repo.repoRoot,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      bus: ctx.events.bus,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await updateState(ctx, (data) => ({
      ...data,
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary']
          ? data['summary']
          : {}),
        blockedReason: `GitHub not configured. Skipping PR and review steps. ${errorMessage}`,
      },
    }));
    await changePhase(ctx, 'complete', 'github_unconfigured');
    return false;
  }
  const planSummary = plan.summary ?? 'Plan';
  const taskUrl = task?.url;
  const taskId = task?.id;
  const prDraftStep = getStepRecord(data, 'pr.draft');
  const existingDraftEntry = getArtifactEntry(data, 'pr.draft', 'draft');
  const existingDraft =
    prDraftStep?.status === 'done' && existingDraftEntry
      ? await readArtifact<{ title: string; body: string }>({ entry: existingDraftEntry })
      : undefined;
  const prDraft =
    prDraftStep?.status === 'done' && existingDraft
      ? existingDraft
      : await runStep(
          ctx,
          'pr.draft',
          'Draft PR description',
          () =>
            draftPullRequest({
              planSummary,
              changesSummary: summary,
              ...(taskUrl ? { taskUrl } : {}),
              ...(taskId ? { taskId } : {}),
              store: conversationStore,
              config: ctx.config,
              cacheDir: ctx.state.cacheDir,
              bus: ctx.events.bus,
              context: emitContext,
            }),
          {
            artifacts: (draft) => ({ draft }),
          },
        );
  await updateState(ctx, (data) => ({
    ...data,
    prDraftSummary: { title: prDraft.title, bodyDigest: hashString(prDraft.body) },
  }));

  const { owner, repo } = githubConfig;
  const headBranch = ctx.repo.branch;
  const baseBranch = ctx.config.github.baseBranch ?? ctx.config.repo.defaultBranch;
  const prStep = getStepRecord(data, 'github.pr.open');
  const existingPr =
    typeof data['pr'] === 'object' && data['pr']
      ? (data['pr'] as {
          pr: { url?: string; number: number; owner: string; repo: string };
        })
      : undefined;
  const prResult =
    prStep?.status === 'done' && existingPr
      ? existingPr
      : await runStep(ctx, 'github.pr.open', 'Open or update PR', () =>
          openOrUpdatePr({
            owner,
            repo,
            headBranch,
            baseBranch,
            title: prDraft.title,
            body: prDraft.body,
            token: githubToken,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
        );
  await updateState(ctx, (data) => ({ ...data, pr: prResult }));

  if (task && prResult.pr.url) {
    const commentStep = getStepRecord(data, 'task.comment_pr_open');
    if (commentStep?.status !== 'done') {
      await runStep(ctx, 'task.comment_pr_open', 'Comment on task with PR', () =>
        commentOnPrOpen(task, ctx.config, prResult.pr.url ?? ''),
      );
    }
  }

  if (task) {
    const moveStep = getStepRecord(data, 'task.move_in_review');
    if (moveStep?.status !== 'done') {
      await runStep(ctx, 'task.move_in_review', 'Move task to In Review', () =>
        moveTaskToInReview(task, ctx.config),
      );
    }
  }

  const initialCiStep = getStepRecord(data, 'ci.wait.initial');
  if (initialCiStep?.status !== 'done') {
    const ciResult = await runStep(ctx, 'ci.wait.initial', 'Wait for CI', () =>
      waitForCi({
        owner,
        repo,
        headBranch,
        token: githubToken,
        pollIntervalMs: 15000,
        timeoutMs: 900000,
        onHeartbeat: () => heartbeatStep(ctx, 'ci.wait.initial'),
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );
    await updateState(ctx, (data) => ({
      ...data,
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary']
          ? data['summary']
          : {}),
        ci: ciResult.state,
      },
    }));
    if (ciResult.state === 'failing') {
      throw new Error('CI failed before review request');
    }
  }

  const shouldRunLocalGateBeforeReview =
    localGateConfig.enabled &&
    (localGateRunWhen === 'beforeReviewRequest' || localGateRunWhen === 'both');
  if (shouldRunLocalGateBeforeReview && !localGateReport) {
    localGateReport = await runStep(
      ctx,
      'review.local_gate',
      'Run local review gate',
      () =>
        generateLocalGateReport({
          repoRoot: ctx.repo.repoRoot,
          baseBranch: gateBaseBranch,
          branchName: ctx.repo.branch,
          ...(ctx.repo.worktreePath ? { worktreePath: ctx.repo.worktreePath } : {}),
          config: ctx.config,
          state: ctx.state,
          runId: ctx.runId,
          bus: ctx.events.bus,
          context: emitContext,
        }),
      {
        artifacts: (report) => ({ report }),
      },
    );

    const blockers = localGateReport.findings.filter(
      (finding) => finding.severity === 'blocker',
    ).length;
    const warnings = localGateReport.findings.filter(
      (finding) => finding.severity === 'warn',
    ).length;

    await updateState(ctx, (data) => ({
      ...data,
      localGateSummary: {
        ok: localGateReport?.ok ?? false,
        blockers,
        warnings,
        generatedAt: localGateReport?.generatedAt,
      },
      summary: {
        ...(typeof data['summary'] === 'object' && data['summary']
          ? data['summary']
          : {}),
        ...(localGateReport
          ? { localGate: formatLocalGateSummary(localGateReport) }
          : {}),
      },
    }));

    if (!localGateReport.ok && localGateConfig.blockPrOnFail) {
      await updateState(ctx, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          blockedReason: 'Local review gate failed.',
        },
      }));
      throw new Error('Local review gate failed');
    }
  }

  if (localGateReport && localGateReport.ok && ctx.config.review.aiReviewer.enabled) {
    const aiReviewStep = getStepRecord(data, 'review.ai_reviewer');
    const existingAiReviewEntry = getArtifactEntry(data, 'review.ai_reviewer', 'report');
    const existingAiReview =
      aiReviewStep?.status === 'done' && existingAiReviewEntry
        ? await readArtifact<import('../review/ai-reviewer').AiReviewReport>({
            entry: existingAiReviewEntry,
          })
        : undefined;
    const diffStat = await runGit(['diff', '--stat', `${gateBaseBranch}...HEAD`], {
      cwd: worktreeRoot,
      bus: ctx.events.bus,
      context: emitContext,
    });
    const aiReview =
      existingAiReview ??
      (await runStep(
        ctx,
        'review.ai_reviewer',
        'Run AI reviewer',
        () =>
          runAiReviewer({
            summary: {
              diffStat: diffStat.stdout.trim(),
              findings: localGateReport.findings.map((finding) => ({
                severity: finding.severity,
                title: finding.title,
                ...(finding.file ? { file: finding.file } : {}),
              })),
            },
            ...(task
              ? {
                  task: {
                    ...(task.key ? { key: task.key } : {}),
                    ...(task.title ? { title: task.title } : {}),
                    ...(task.acceptanceCriteria.length > 0
                      ? { acceptanceCriteria: task.acceptanceCriteria }
                      : {}),
                  },
                }
              : {}),
            store: conversationStore,
            config: ctx.config,
            bus: ctx.events.bus,
            context: emitContext,
          }),
        {
          artifacts: (report) => ({ report }),
        },
      ));

    await updateState(ctx, (data) => ({
      ...data,
      aiReviewSummary: {
        shipIt: aiReview.shipIt,
        issues: aiReview.issues.length,
      },
    }));
  }
  const reviewStep = getStepRecord(data, 'github.review.request');
  const reviewIntelligence = ctx.config.review.intelligence;
  let reviewerSuggestions: Awaited<ReturnType<typeof suggestReviewers>> | null = null;
  if (reviewIntelligence?.enabled && reviewIntelligence.reviewerSuggestions.enabled) {
    try {
      const reviewerStats = await readReviewerStats(ctx.state);
      reviewerSuggestions = await suggestReviewers({
        repoRoot: worktreeRoot,
        baseBranch,
        headBranch: headBranch ?? baseBranch,
        reviewerAliases: reviewIntelligence.reviewerSuggestions.reviewerAliases ?? {},
        useCodeowners: reviewIntelligence.reviewerSuggestions.useCodeowners,
        useBlame: reviewIntelligence.reviewerSuggestions.useBlame,
        maxSuggestions: reviewIntelligence.reviewerSuggestions.maxSuggestions,
        reviewerStats,
      });
      if (reviewerSuggestions) {
        const suggestions = reviewerSuggestions;
        await updateState(ctx, (data) => ({
          ...data,
          reviewerSuggestions: {
            users: suggestions.users,
            teams: suggestions.teams,
            sources: suggestions.sources,
            changedFiles: suggestions.changedFiles,
            generatedAt: new Date().toISOString(),
          },
        }));
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to suggest reviewers';
      await updateState(ctx, (data) => ({
        ...data,
        reviewerSuggestions: {
          users: [],
          teams: [],
          sources: { codeowners: [], blame: [] },
          changedFiles: [],
          generatedAt: new Date().toISOString(),
          error: message,
        },
      }));
    }
  }

  const suggestedUsers = reviewerSuggestions?.users ?? [];
  const reviewersToRequest =
    ctx.config.github.reviewers.length > 0
      ? ctx.config.github.reviewers
      : reviewIntelligence?.reviewerSuggestions.autoRequest
        ? suggestedUsers
        : [];

  const requestKey = reviewRequestKey({
    prNumber: prResult.pr.number,
    reviewers: reviewersToRequest,
    requestCopilot: ctx.config.github.requestCopilot,
  });
  const existingRequestKey =
    typeof data['reviewRequestKey'] === 'string' ? data['reviewRequestKey'] : undefined;
  if (reviewStep?.status !== 'done' || existingRequestKey !== requestKey) {
    await runStep(ctx, 'github.review.request', 'Request reviewers', () =>
      requestReviewers({
        pr: prResult.pr,
        reviewers: reviewersToRequest,
        requestCopilot: ctx.config.github.requestCopilot,
        token: githubToken,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
      }),
    );
    const requestedAt = new Date().toISOString();
    await updateState(ctx, (data) => ({
      ...data,
      reviewRequestKey: requestKey,
      reviewRequest: {
        reviewers: reviewersToRequest,
        suggestedReviewers: suggestedUsers,
        requestedAt,
        copilot: ctx.config.github.requestCopilot,
      },
    }));
    if (reviewersToRequest.length > 0) {
      await recordReviewerRequests({ state: ctx.state, reviewers: reviewersToRequest });
    }
  }

  await updateState(ctx, (data) => ({ ...data, pr: prResult.pr }));
  return true;
}
