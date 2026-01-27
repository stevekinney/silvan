import { decideVerification } from '../ai/cognition/verifier';
import type { createConversationStore } from '../ai/conversation';
import type { EmitContext } from '../events/emit';
import { runVerifyCommands } from '../verify/run';
import { triageVerificationFailures } from '../verify/triage';
import type { RunContext } from './context';
import {
  attemptVerificationAutoFix,
  changePhase,
  getRunState,
  getStepRecord,
  recordVerificationAssist,
  type RunControllerOptions,
  runStep,
  updateState,
} from './run-helpers';

type ConversationStore = ReturnType<typeof createConversationStore>;

type VerificationInput = {
  ctx: RunContext;
  controllerOptions: RunControllerOptions;
  conversationStore: ConversationStore;
  emitContext: EmitContext;
  worktreeRoot: string;
};

export async function runVerification(options: VerificationInput): Promise<void> {
  const { ctx, controllerOptions, conversationStore, emitContext, worktreeRoot } =
    options;
  const state = await ctx.state.readRunState(ctx.runId);
  const data = getRunState((state?.data as Record<string, unknown>) ?? {});

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

  if (verifyReport.ok) {
    return;
  }

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
    controllerOptions,
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

  if (autoFixOutcome.resolved) {
    return;
  }

  const decision = await runStep(
    ctx,
    'verify.decide',
    'Decide verification next steps',
    async () => {
      if (controllerOptions.apply && !triage.classified) {
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
