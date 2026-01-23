import { appendMessages } from 'conversationalist';
import { ProseWriter } from 'prose-writer';

import { executePlan } from '../agent/executor';
import type { Plan } from '../agent/schemas';
import { generateCiFixPlan } from '../ai/cognition/ci-triager';
import { classifyReviewThreads } from '../ai/cognition/review-classifier';
import { generateReviewRemediationKickoffPrompt } from '../ai/cognition/review-kickoff';
import { generateReviewFixPlan } from '../ai/cognition/reviewer';
import { createConversationStore } from '../ai/conversation';
import { requireGitHubAuth, requireGitHubConfig } from '../config/validate';
import { runGit } from '../git/exec';
import { waitForCi } from '../github/ci';
import { requestReviewers } from '../github/pr';
import {
  fetchReviewResponses,
  fetchReviewThreadById,
  fetchUnresolvedReviewComments,
  replyToReviewComment,
  resolveReviewThread,
} from '../github/review';
import { hashPrompt, renderPromptSummary } from '../prompts';
import {
  applySeverityPolicy,
  buildReviewPriorityList,
  buildSeverityIndex,
  buildSeveritySummary,
} from '../review/intelligence';
import {
  buildReviewPlanThreads,
  type ReviewThreadFingerprint,
  selectThreadsForContext,
} from '../review/planning';
import { recordReviewerResponses } from '../state/reviewers';
import { completeTask } from '../task/lifecycle';
import type { Task } from '../task/types';
import { hashString } from '../utils/hash';
import { runVerifyCommands } from '../verify/run';
import type { RunContext } from './context';
import {
  changePhase,
  createCheckpointCommit,
  getBudgetsForPhase,
  getModelForPhase,
  getRunState,
  getStepRecord,
  getToolBudget,
  heartbeatStep,
  recordArtifacts,
  recordVerificationAssist,
  reviewRequestKey,
  type RunControllerOptions,
  runStep,
  updateState,
} from './run-helpers';

export async function runReviewLoop(ctx: RunContext, options: RunControllerOptions) {
  await changePhase(ctx, 'review');
  const githubToken = requireGitHubAuth(ctx.config);
  const execModel = getModelForPhase(ctx.config, 'execute');
  const execBudgets = getBudgetsForPhase(ctx.config, 'execute');
  const worktreeRoot = ctx.repo.worktreePath ?? ctx.repo.repoRoot;
  const headBranch = ctx.repo.branch;
  const reviewState = await ctx.state.readRunState(ctx.runId);
  const reviewData = (reviewState?.data as Record<string, unknown>) ?? {};
  const reviewTask =
    typeof reviewData['task'] === 'object' && reviewData['task']
      ? (reviewData['task'] as Task)
      : undefined;
  const emitContext = {
    runId: ctx.runId,
    repoRoot: ctx.repo.repoRoot,
    mode: ctx.events.mode,
    ...(reviewTask ? { taskId: reviewTask.id } : {}),
  };
  const conversationStore = createConversationStore({
    runId: ctx.runId,
    state: ctx.state,
    config: ctx.config,
    bus: ctx.events.bus,
    context: emitContext,
  });
  const github = await requireGitHubConfig({
    config: ctx.config,
    repoRoot: ctx.repo.repoRoot,
    context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode: ctx.events.mode },
    bus: ctx.events.bus,
  });
  const { owner, repo } = github;
  const maxIterations = ctx.config.review.maxIterations ?? 3;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const iterationIndex = iteration + 1;
    const iterationState = await ctx.state.readRunState(ctx.runId);
    const iterationData = getRunState(iterationState?.data ?? {});
    const priorCheckpoint =
      typeof iterationData['lastReviewCheckpoint'] === 'string'
        ? iterationData['lastReviewCheckpoint']
        : undefined;

    try {
      const ciResult = await runStep(ctx, 'ci.wait.review', 'Wait for CI', () =>
        waitForCi({
          owner,
          repo,
          headBranch,
          token: githubToken,
          pollIntervalMs: 15000,
          timeoutMs: 900000,
          onHeartbeat: () => heartbeatStep(ctx, 'ci.wait.review'),
          bus: ctx.events.bus,
          context: {
            runId: ctx.runId,
            repoRoot: ctx.repo.repoRoot,
            mode: ctx.events.mode,
          },
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

      let finalCiState = ciResult.state;
      if (ciResult.state === 'failing') {
        const ciChecks = ciResult.checks ?? [];
        const ciPlan = await runStep(
          ctx,
          'ci.fix.plan',
          'Plan CI fixes',
          () =>
            generateCiFixPlan({
              ci: {
                state: ciResult.state,
                ...(ciResult.summary ? { summary: ciResult.summary } : {}),
                checks: ciChecks.map((check) => ({
                  name: check.name,
                  ...(check.conclusion ? { conclusion: check.conclusion } : {}),
                  ...(check.url ? { url: check.url } : {}),
                })),
              },
              store: conversationStore,
              config: ctx.config,
              ...(ctx.events.bus ? { bus: ctx.events.bus } : {}),
              context: emitContext,
            }),
          {
            artifacts: (result) => ({ plan: result }),
          },
        );

        await updateState(ctx, (data) => ({
          ...data,
          ciFixSummary: {
            summary: ciPlan.summary,
            steps: ciPlan.steps.length,
          },
        }));

        const ciPlanDigest = hashString(JSON.stringify(ciPlan));
        await runStep(ctx, 'ci.fix.apply', 'Apply CI fixes', () =>
          (async () => {
            const execPrompt = new ProseWriter();
            execPrompt.write('You are the implementation agent for Silvan.');
            execPrompt.write('Follow the plan step-by-step, using tools when needed.');
            execPrompt.write('Do not invent file contents; use fs.read before edits.');
            execPrompt.write('Keep changes minimal and aligned to the plan.');
            execPrompt.write(
              'Use silvan.plan.read to fetch the full plan before making edits.',
            );
            execPrompt.write('Return a brief summary of changes.');
            execPrompt.write(`Plan digest: ${ciPlanDigest}`);

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
              ...execBudgets,
              ...getToolBudget(ctx.config),
              ...(options.sessions ? { sessionPool: options.sessions } : {}),
              bus: ctx.events.bus,
              context: emitContext,
              state: ctx.state,
              heartbeat: () => heartbeatStep(ctx, 'ci.fix.apply'),
            });

            const execConversation = appendMessages(execSnapshot.conversation, {
              role: 'assistant',
              content: `CI fix summary: ${result}`,
              metadata: { kind: 'ci', protected: true },
            });
            await conversationStore.save(execConversation);
            return result;
          })(),
        );

        const ciVerify = await runStep(ctx, 'ci.fix.verify', 'Verify CI fixes', () =>
          runVerifyCommands(ctx.config, { cwd: worktreeRoot }),
        );
        if (!ciVerify.ok) {
          await recordVerificationAssist({
            ctx,
            report: ciVerify,
            context: 'ci_fix',
            emitContext,
          });
          throw new Error('Verification failed during CI fix');
        }

        await runStep(ctx, 'ci.fix.checkpoint', 'Checkpoint CI fixes', () =>
          createCheckpointCommit(ctx, `silvan: checkpoint ci-${iteration + 1}`),
        );

        await runStep(ctx, 'ci.fix.push', 'Push CI fixes', () =>
          runGit(['push', 'origin', headBranch], {
            cwd: worktreeRoot,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
          }),
        );

        const ciAfter = await runStep(ctx, 'ci.wait.review', 'Wait for CI', () =>
          waitForCi({
            owner,
            repo,
            headBranch,
            token: githubToken,
            pollIntervalMs: 15000,
            timeoutMs: 900000,
            onHeartbeat: () => heartbeatStep(ctx, 'ci.wait.review'),
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
        );
        finalCiState = ciAfter.state;
        if (ciAfter.state === 'failing') {
          await updateState(ctx, (data) => ({
            ...data,
            summary: {
              ...(typeof data['summary'] === 'object' && data['summary']
                ? data['summary']
                : {}),
              blockedReason: 'CI still failing after automated fixes.',
            },
          }));
          await recordArtifacts(ctx, 'review-iterations', {
            [`iteration-${iterationIndex}`]: {
              iteration: iterationIndex,
              status: 'blocked',
              reason: 'ci_fix_failed',
              unresolvedBefore: 0,
              actionable: 0,
              ignored: 0,
              ciState: ciAfter.state,
              generatedAt: new Date().toISOString(),
            },
          });
          throw new Error('CI still failing after fixes');
        }
        continue;
      }

      const review = await runStep(
        ctx,
        'github.review.fetch',
        'Fetch review comments',
        () =>
          fetchUnresolvedReviewComments({
            owner,
            repo,
            headBranch,
            token: githubToken,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
      );

      await updateState(ctx, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          unresolvedReviewCount: review.comments.length,
        },
      }));

      const reviewRequest = (typeof iterationData['reviewRequest'] === 'object' &&
      iterationData['reviewRequest']
        ? (iterationData['reviewRequest'] as {
            reviewers?: string[];
            requestedAt?: string;
          })
        : undefined) ?? { reviewers: [], requestedAt: undefined };
      const requestedAt = reviewRequest.requestedAt;
      const requestedReviewers = Array.isArray(reviewRequest.reviewers)
        ? reviewRequest.reviewers
        : [];

      if (requestedAt && requestedReviewers.length > 0) {
        const responses = await fetchReviewResponses({
          pr: review.pr,
          token: githubToken,
          since: requestedAt,
          bus: ctx.events.bus,
          context: emitContext,
        });
        const responseByReviewer = new Map<string, { submittedAt: string }>();
        for (const response of responses) {
          const existing = responseByReviewer.get(response.reviewer);
          if (!existing || response.submittedAt < existing.submittedAt) {
            responseByReviewer.set(response.reviewer, {
              submittedAt: response.submittedAt,
            });
          }
        }
        const respondedReviewers = Array.from(responseByReviewer.keys());
        const pendingReviewers = requestedReviewers.filter(
          (reviewer) => !responseByReviewer.has(reviewer),
        );
        const requestTs = Date.parse(requestedAt);
        const responseTimes = respondedReviewers
          .map((reviewer) => {
            const submittedAt = responseByReviewer.get(reviewer)?.submittedAt ?? '';
            const submittedTs = Date.parse(submittedAt);
            if (Number.isNaN(requestTs) || Number.isNaN(submittedTs)) return null;
            const hours = (submittedTs - requestTs) / (1000 * 60 * 60);
            return { reviewer, responseHours: hours, respondedAt: submittedAt };
          })
          .filter(
            (
              entry,
            ): entry is {
              reviewer: string;
              responseHours: number;
              respondedAt: string;
            } => entry !== null,
          );
        const avgResponseHours =
          responseTimes.length > 0
            ? responseTimes.reduce((sum, entry) => sum + entry.responseHours, 0) /
              responseTimes.length
            : undefined;
        const previousSummary = (iterationData['reviewResponseSummary'] as
          | { respondedReviewers?: string[] }
          | undefined) ?? { respondedReviewers: [] };
        const recordedReviewers = new Set(previousSummary.respondedReviewers ?? []);
        const newResponses = responseTimes.filter(
          (entry) => !recordedReviewers.has(entry.reviewer),
        );
        if (newResponses.length > 0) {
          await recordReviewerResponses({ state: ctx.state, responses: newResponses });
        }
        await updateState(ctx, (data) => ({
          ...data,
          reviewResponseSummary: {
            requestedAt,
            reviewers: requestedReviewers,
            respondedReviewers,
            pendingReviewers,
            ...(avgResponseHours !== undefined ? { avgResponseHours } : {}),
            ...(responseTimes.length > 0
              ? {
                  lastResponseAt: responseTimes
                    .map((entry) => entry.respondedAt)
                    .sort()
                    .slice(-1)[0],
                }
              : {}),
          },
        }));
      }

      if (review.comments.length === 0 && ciResult.state === 'passing') {
        await changePhase(ctx, 'complete', 'review_loop_clean');
        const latest = await ctx.state.readRunState(ctx.runId);
        const latestData = getRunState((latest?.data as Record<string, unknown>) ?? {});
        const task = latestData['task'] as Task | undefined;
        if (task) {
          await runStep(ctx, 'task.move_done', 'Move task to Done', () =>
            completeTask(task, ctx.config),
          );
        }
        break;
      }

      const threadFingerprints = review.comments.reduce<
        Record<string, ReviewThreadFingerprint>
      >((acc, comment) => {
        const entry = (acc[comment.threadId] ??= {
          threadId: comment.threadId,
          comments: [],
          isOutdated: comment.isOutdated,
        });
        entry.comments.push({
          id: comment.id,
          databaseId: comment.databaseId ?? null,
          path: comment.path,
          line: comment.line,
          bodyDigest: hashString(comment.body),
          excerpt: comment.body.slice(0, 160),
        });
        return acc;
      }, {});

      await recordArtifacts(ctx, 'github.review.fetch', {
        threads: Object.values(threadFingerprints),
      });

      const reviewKickoff = await runStep(
        ctx,
        'review.kickoff',
        'Generate review remediation kickoff',
        () =>
          generateReviewRemediationKickoffPrompt({
            task: reviewTask ?? {
              id: 'unknown',
              key: 'unknown',
              provider: 'local',
              title: 'Unknown task',
              description: '',
              acceptanceCriteria: [],
              labels: [],
            },
            pr: {
              id: `${review.pr.owner}/${review.pr.repo}#${review.pr.number}`,
              ...(review.pr.url ? { url: review.pr.url } : {}),
              branch: headBranch,
            },
            review: {
              unresolvedThreadCount: review.comments.length,
              threadFingerprints: Object.values(threadFingerprints).map((thread) => ({
                threadId: thread.threadId,
                commentIds: thread.comments.map((comment) => comment.id),
                path: thread.comments[0]?.path ?? null,
                line: thread.comments[0]?.line ?? 0,
                isOutdated: thread.isOutdated,
                bodyHash: thread.comments[0]?.bodyDigest ?? '',
                excerpt: thread.comments[0]?.excerpt ?? '',
              })),
            },
            ci: {
              state: ciResult.state,
              ...(ciResult.summary ? { summary: ciResult.summary } : {}),
              failedChecks: (ciResult.checks ?? [])
                .filter((check) => check.conclusion === 'failure')
                .map((check) => check.name),
            },
            repo: {
              frameworks: [],
              verificationCommands: ctx.config.verify.commands.map(
                (command) => command.cmd,
              ),
            },
            store: conversationStore,
            config: ctx.config,
            bus: ctx.events.bus,
            context: emitContext,
          }),
        {
          artifacts: (prompt) => ({ review_remediation_kickoff: prompt }),
        },
      );

      await updateState(ctx, (data) => ({
        ...data,
        promptDigests: {
          ...(typeof data['promptDigests'] === 'object' && data['promptDigests']
            ? data['promptDigests']
            : {}),
          review_remediation_kickoff: hashPrompt(reviewKickoff),
        },
        promptSummaries: {
          ...(typeof data['promptSummaries'] === 'object' && data['promptSummaries']
            ? data['promptSummaries']
            : {}),
          review_remediation_kickoff: renderPromptSummary(reviewKickoff),
        },
      }));

      const classification = await runStep(
        ctx,
        'review.classify',
        'Classify review threads',
        () =>
          classifyReviewThreads({
            threads: Object.values(threadFingerprints),
            store: conversationStore,
            config: ctx.config,
            cacheDir: ctx.state.cacheDir,
            bus: ctx.events.bus,
            context: emitContext,
          }),
        {
          artifacts: (result) => ({ classification: result }),
          inputs: { threadCount: review.comments.length },
        },
      );

      const fingerprintList = Object.values(threadFingerprints);
      const reviewIntelligence = ctx.config.review.intelligence;
      const severityIndex = buildSeverityIndex({
        classification,
        fingerprints: fingerprintList,
      });
      const severitySummary = buildSeveritySummary(severityIndex.severityByThreadId);
      const applyIntelligence = reviewIntelligence.enabled;
      const policyAction = applyIntelligence
        ? applySeverityPolicy({
            severityByThreadId: severityIndex.severityByThreadId,
            policy: reviewIntelligence.severityPolicy,
          })
        : {
            actionableThreadIds: classification.actionableThreadIds,
            ignoredThreadIds: classification.ignoredThreadIds,
            autoResolveThreadIds: [],
          };

      let actionableThreadIds = policyAction.actionableThreadIds;
      let ignoredThreadIds = policyAction.ignoredThreadIds;
      let autoResolveThreadIds = policyAction.autoResolveThreadIds;

      if (!applyIntelligence) {
        autoResolveThreadIds = [];
      }

      await updateState(ctx, (data) => ({
        ...data,
        reviewClassificationSummary: {
          actionable: actionableThreadIds.length,
          ignored: ignoredThreadIds.length,
          needsContext: classification.needsContextThreadIds.length,
          severity: severitySummary,
        },
        reviewThreadPriority: buildReviewPriorityList({
          fingerprints: fingerprintList,
          severityByThreadId: severityIndex.severityByThreadId,
          summaryByThreadId: severityIndex.summaryByThreadId,
        }),
      }));
      const threadsNeedingContext = selectThreadsForContext({
        fingerprints: fingerprintList,
        needsContextThreadIds: classification.needsContextThreadIds,
      });

      const autoResolveEnabled = applyIntelligence && autoResolveThreadIds.length > 0;
      let resolvedAutoResolveIds: string[] = [];
      let autoResolveFailures: Array<{ threadId: string; reason: string }> = [];
      let autoResolveSkipped: Array<{ threadId: string; reason: string }> = [];

      if (autoResolveEnabled) {
        const allowAutoResolve = Boolean(options.apply);
        if (!allowAutoResolve) {
          autoResolveSkipped = autoResolveThreadIds.map((threadId) => ({
            threadId,
            reason: 'apply_disabled',
          }));
        } else {
          const autoResolveStep = getStepRecord(iterationData, 'review.nitpick.resolve');
          if (autoResolveStep?.status !== 'done') {
            const autoResolveResult = await runStep(
              ctx,
              'review.nitpick.resolve',
              'Resolve nitpick review threads',
              async () => {
                const resolved: string[] = [];
                const skipped: Array<{ threadId: string; reason: string }> = [];
                const failed: Array<{ threadId: string; reason: string }> = [];
                const byId = new Map(
                  fingerprintList.map((thread) => [thread.threadId, thread]),
                );

                for (const threadId of autoResolveThreadIds) {
                  const thread = byId.get(threadId);
                  if (!thread) {
                    skipped.push({ threadId, reason: 'missing_thread' });
                    continue;
                  }
                  if (thread.isOutdated) {
                    skipped.push({ threadId, reason: 'outdated_thread' });
                    continue;
                  }
                  const commentId = thread.comments[0]?.databaseId;
                  if (!commentId) {
                    skipped.push({ threadId, reason: 'missing_comment_id' });
                    continue;
                  }
                  try {
                    await replyToReviewComment({
                      pr: review.pr,
                      commentId,
                      body: reviewIntelligence.nitpickAcknowledgement,
                      token: githubToken,
                      bus: ctx.events.bus,
                      context: emitContext,
                    });
                    await resolveReviewThread({
                      threadId,
                      pr: review.pr,
                      token: githubToken,
                      bus: ctx.events.bus,
                      context: emitContext,
                    });
                    resolved.push(threadId);
                  } catch (error) {
                    const reason =
                      error instanceof Error ? error.message : 'failed_to_resolve';
                    failed.push({ threadId, reason });
                  }
                }
                return { resolved, skipped, failed };
              },
              {
                inputs: { count: autoResolveThreadIds.length },
                artifacts: (result) => ({ result }),
              },
            );
            resolvedAutoResolveIds = autoResolveResult.resolved;
            autoResolveFailures = autoResolveResult.failed;
            autoResolveSkipped = autoResolveResult.skipped;
          }
        }
      }

      if (autoResolveEnabled) {
        const resolvedSet = new Set(resolvedAutoResolveIds);
        const unresolvedAutoResolve = [
          ...autoResolveFailures.map((item) => item.threadId),
          ...autoResolveSkipped.map((item) => item.threadId),
        ];
        actionableThreadIds = [
          ...new Set([
            ...actionableThreadIds.filter((id) => !resolvedSet.has(id)),
            ...unresolvedAutoResolve,
          ]),
        ];
        ignoredThreadIds = ignoredThreadIds.filter((id) => !resolvedSet.has(id));
        await updateState(ctx, (data) => ({
          ...data,
          reviewClassificationSummary: {
            actionable: actionableThreadIds.length,
            ignored: ignoredThreadIds.length,
            needsContext: classification.needsContextThreadIds.length,
            severity: severitySummary,
            autoResolved: resolvedAutoResolveIds.length,
          },
          reviewAutoResolveSummary: {
            attempted: autoResolveThreadIds.length,
            resolved: resolvedAutoResolveIds.length,
            skipped: autoResolveSkipped.length,
            failed: autoResolveFailures.length,
            ...(autoResolveFailures.length > 0 ? { failures: autoResolveFailures } : {}),
            ...(autoResolveSkipped.length > 0 ? { skipped: autoResolveSkipped } : {}),
          },
        }));
      }

      const detailedThreads = threadsNeedingContext.length
        ? await runStep(
            ctx,
            'review.thread.fetch',
            'Fetch full review threads',
            async () => {
              const results: Array<{
                threadId: string;
                comments: Array<{
                  id: string;
                  path: string | null;
                  line: number | null;
                  body: string;
                  url?: string | null;
                }>;
                isOutdated: boolean;
              }> = [];

              for (const threadId of threadsNeedingContext) {
                const thread = await fetchReviewThreadById({
                  threadId,
                  token: githubToken,
                  bus: ctx.events.bus,
                  context: {
                    runId: ctx.runId,
                    repoRoot: ctx.repo.repoRoot,
                    mode: ctx.events.mode,
                  },
                });
                results.push({
                  threadId: thread.id,
                  isOutdated: thread.isOutdated,
                  comments: thread.comments.nodes.map((comment) => ({
                    id: comment.id,
                    databaseId: comment.databaseId ?? null,
                    path: comment.path,
                    line: comment.line,
                    body: comment.body,
                    url: comment.url ?? null,
                  })),
                });
              }
              return results;
            },
            {
              inputs: { threadCount: threadsNeedingContext.length },
              artifacts: (result) => ({ threads: result }),
            },
          )
        : [];

      const threadsForPlan = buildReviewPlanThreads({
        fingerprints: fingerprintList,
        detailedThreads,
        actionableThreadIds,
        ignoredThreadIds,
      });

      const fixPlan = await runStep(
        ctx,
        'review.plan',
        'Plan review fixes',
        () =>
          generateReviewFixPlan({
            threads: threadsForPlan,
            store: conversationStore,
            config: ctx.config,
            cacheDir: ctx.state.cacheDir,
            bus: ctx.events.bus,
            context: emitContext,
          }),
        {
          inputs: {
            actionable: actionableThreadIds.length,
            ignored: ignoredThreadIds.length,
          },
          artifacts: (result) => ({ plan: result }),
        },
      );

      await updateState(ctx, (data) => ({
        ...data,
        reviewFixPlanSummary: {
          actionable: fixPlan.threads.filter((thread) => thread.actionable).length,
          ignored: fixPlan.threads.filter((thread) => !thread.actionable).length,
        },
        reviewIteration: iteration + 1,
      }));

      const actionableThreads = fixPlan.threads.filter((thread) => thread.actionable);
      if (
        actionableThreads.length === 0 &&
        (!fixPlan.resolveThreads || fixPlan.resolveThreads.length === 0)
      ) {
        await updateState(ctx, (data) => ({
          ...data,
          summary: {
            ...(typeof data['summary'] === 'object' && data['summary']
              ? data['summary']
              : {}),
            blockedReason: 'No actionable review fixes identified.',
          },
        }));
        await recordArtifacts(ctx, 'review-iterations', {
          [`iteration-${iterationIndex}`]: {
            iteration: iterationIndex,
            status: 'blocked',
            reason: 'no_actionable_fixes',
            unresolvedBefore: review.comments.length,
            actionable: actionableThreads.length,
            ignored: fixPlan.threads.length - actionableThreads.length,
            generatedAt: new Date().toISOString(),
          },
        });
        throw new Error('No actionable review fixes identified; manual review required');
      }
      if (actionableThreads.length > 0) {
        const reviewPlan: Plan = {
          summary: 'Review fixes',
          steps: actionableThreads.map((thread) => ({
            id: thread.threadId,
            title: thread.summary,
            description: thread.summary,
          })),
          verification: fixPlan.verification ?? [],
        };
        const reviewPlanDigest = hashString(JSON.stringify(reviewPlan));
        await runStep(ctx, 'review.apply', 'Apply review fixes', () =>
          (async () => {
            const execPrompt = new ProseWriter();
            execPrompt.write('You are the implementation agent for Silvan.');
            execPrompt.write('Follow the plan step-by-step, using tools when needed.');
            execPrompt.write('Do not invent file contents; use fs.read before edits.');
            execPrompt.write('Keep changes minimal and aligned to the plan.');
            execPrompt.write(
              'Use silvan.plan.read to fetch the full plan before making edits.',
            );
            execPrompt.write('Return a brief summary of changes.');
            execPrompt.write(`Plan digest: ${reviewPlanDigest}`);

            const execSnapshot = await conversationStore.append({
              role: 'system',
              content: execPrompt.toString().trimEnd(),
              metadata: { kind: 'review' },
            });

            const result = await executePlan({
              snapshot: execSnapshot,
              model: execModel,
              repoRoot: worktreeRoot,
              config: ctx.config,
              dryRun: Boolean(options.dryRun),
              allowDestructive: Boolean(options.apply),
              allowDangerous: Boolean(options.dangerous),
              ...execBudgets,
              ...getToolBudget(ctx.config),
              ...(options.sessions ? { sessionPool: options.sessions } : {}),
              bus: ctx.events.bus,
              context: emitContext,
              state: ctx.state,
              heartbeat: () => heartbeatStep(ctx, 'review.apply'),
            });

            const execConversation = appendMessages(execSnapshot.conversation, {
              role: 'assistant',
              content: `Review fix summary: ${result}`,
              metadata: { kind: 'review', protected: true },
            });
            await conversationStore.save(execConversation);
            return result;
          })(),
        );

        const verifyReport = await runStep(
          ctx,
          'review.verify',
          'Verify review fixes',
          () => runVerifyCommands(ctx.config, { cwd: worktreeRoot }),
          { artifacts: (report) => ({ report }) },
        );
        await updateState(ctx, (data) => ({
          ...data,
          reviewVerifySummary: {
            ok: verifyReport.ok,
            lastRunAt: new Date().toISOString(),
          },
        }));
        if (!verifyReport.ok) {
          await recordVerificationAssist({
            ctx,
            report: verifyReport,
            context: 'review',
            emitContext,
          });
          throw new Error('Verification failed during review loop');
        }
      }

      let reviewCheckpointSha: string | undefined;
      if (actionableThreads.length > 0) {
        const reviewCheckpoint = await runStep(
          ctx,
          'review.checkpoint',
          'Checkpoint review fixes',
          () => createCheckpointCommit(ctx, `silvan: checkpoint review-${iteration + 1}`),
          {
            inputs: { iteration: iteration + 1 },
            artifacts: (result) => ({ checkpoint: result }),
          },
        );
        if (reviewCheckpoint?.sha) {
          reviewCheckpointSha = reviewCheckpoint.sha;
          await updateState(ctx, (data) => ({
            ...data,
            checkpoints: [
              ...((data['checkpoints'] as string[]) ?? []),
              reviewCheckpoint.sha,
            ],
            lastReviewCheckpoint: reviewCheckpoint.sha,
          }));
        }

        await runStep(ctx, 'review.push', 'Push review fixes', () =>
          runGit(['push', 'origin', headBranch], {
            cwd: worktreeRoot,
            context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot },
          }),
        );

        const ciAfter = await runStep(ctx, 'ci.wait', 'Wait for CI', () =>
          waitForCi({
            owner,
            repo,
            headBranch,
            token: githubToken,
            pollIntervalMs: 15000,
            timeoutMs: 900000,
            onHeartbeat: () => heartbeatStep(ctx, 'ci.wait'),
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
        );
        finalCiState = ciAfter.state;
        await updateState(ctx, (data) => ({
          ...data,
          summary: {
            ...(typeof data['summary'] === 'object' && data['summary']
              ? data['summary']
              : {}),
            ci: ciAfter.state,
          },
        }));
        if (ciAfter.state === 'failing') {
          const flaky =
            reviewCheckpointSha &&
            priorCheckpoint &&
            reviewCheckpointSha === priorCheckpoint;
          await updateState(ctx, (data) => ({
            ...data,
            summary: {
              ...(typeof data['summary'] === 'object' && data['summary']
                ? data['summary']
                : {}),
              blockedReason: flaky
                ? 'CI failed without new changes (possible flake).'
                : 'CI failed during review loop.',
            },
          }));
          await recordArtifacts(ctx, 'review-iterations', {
            [`iteration-${iterationIndex}`]: {
              iteration: iterationIndex,
              status: 'blocked',
              reason: flaky ? 'ci_flaky' : 'ci_failed',
              unresolvedBefore: review.comments.length,
              actionable: actionableThreads.length,
              ignored: fixPlan.threads.length - actionableThreads.length,
              ciState: ciAfter.state,
              checkpointSha: reviewCheckpointSha ?? null,
              generatedAt: new Date().toISOString(),
            },
          });
          throw new Error(
            flaky
              ? 'CI failed without new changes (possible flake).'
              : 'CI failed during review loop',
          );
        }
      }

      if (fixPlan.resolveThreads?.length) {
        const resolvedState = await ctx.state.readRunState(ctx.runId);
        const resolvedData = (resolvedState?.data as Record<string, unknown>) ?? {};
        const resolvedThreads = new Set(
          Array.isArray(resolvedData['resolvedThreads'])
            ? (resolvedData['resolvedThreads'] as string[])
            : [],
        );
        for (const threadId of fixPlan.resolveThreads) {
          if (resolvedThreads.has(threadId)) continue;
          await runStep(ctx, 'review.resolve', 'Resolve review thread', () =>
            resolveReviewThread({
              threadId,
              pr: review.pr,
              token: githubToken,
              bus: ctx.events.bus,
              context: {
                runId: ctx.runId,
                repoRoot: ctx.repo.repoRoot,
                mode: ctx.events.mode,
              },
            }),
          );
          resolvedThreads.add(threadId);
          await updateState(ctx, (data) => ({
            ...data,
            resolvedThreads: Array.from(resolvedThreads),
          }));
        }
      }

      const reRequestKey = reviewRequestKey({
        prNumber: review.pr.number,
        reviewers: ctx.config.github.reviewers,
        requestCopilot: ctx.config.github.requestCopilot,
      });
      const reRequestKeyWithIteration = hashString(
        JSON.stringify({ key: reRequestKey, iteration: iteration + 1 }),
      );
      const latestState = await ctx.state.readRunState(ctx.runId);
      const latestData = (latestState?.data as Record<string, unknown>) ?? {};
      const existingReRequestKey =
        typeof latestData['reviewRequestKey'] === 'string'
          ? latestData['reviewRequestKey']
          : undefined;
      if (existingReRequestKey !== reRequestKeyWithIteration) {
        await runStep(ctx, 'github.review.request', 'Re-request reviewers', () =>
          requestReviewers({
            pr: review.pr,
            reviewers: ctx.config.github.reviewers,
            requestCopilot: ctx.config.github.requestCopilot,
            token: githubToken,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
        );
        await updateState(ctx, (data) => ({
          ...data,
          reviewRequestKey: reRequestKeyWithIteration,
        }));
      }

      const reviewAfter = await runStep(
        ctx,
        'github.review.fetch.post',
        'Refetch review comments',
        () =>
          fetchUnresolvedReviewComments({
            owner,
            repo,
            headBranch,
            token: githubToken,
            bus: ctx.events.bus,
            context: {
              runId: ctx.runId,
              repoRoot: ctx.repo.repoRoot,
              mode: ctx.events.mode,
            },
          }),
      );

      await updateState(ctx, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          unresolvedReviewCount: reviewAfter.comments.length,
        },
      }));

      const resolvedThreadsSnapshot = await ctx.state.readRunState(ctx.runId);
      const resolvedThreadsData =
        (resolvedThreadsSnapshot?.data as Record<string, unknown>) ?? {};
      const resolvedThreadsList = Array.isArray(resolvedThreadsData['resolvedThreads'])
        ? (resolvedThreadsData['resolvedThreads'] as string[])
        : [];

      await recordArtifacts(ctx, 'review-iterations', {
        [`iteration-${iterationIndex}`]: {
          iteration: iterationIndex,
          status: 'completed',
          unresolvedBefore: review.comments.length,
          unresolvedAfter: reviewAfter.comments.length,
          actionable: actionableThreads.length,
          ignored: fixPlan.threads.length - actionableThreads.length,
          ciState: finalCiState,
          checkpointSha: reviewCheckpointSha ?? null,
          resolvedThreads: resolvedThreadsList,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Review loop failed';
      await updateState(ctx, (data) => ({
        ...data,
        summary: {
          ...(typeof data['summary'] === 'object' && data['summary']
            ? data['summary']
            : {}),
          blockedReason: message,
        },
      }));
      throw error;
    }
  }
}
