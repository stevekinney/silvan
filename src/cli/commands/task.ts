import { spawnSync } from 'node:child_process';

import type { CAC } from 'cac';

import { type ClarificationQuestion, collectClarifications } from '../../agent/clarify';
import type { SessionPool } from '../../agent/session';
import type { RunContext } from '../../core/context';
import { SilvanError } from '../../core/errors';
import { runStep } from '../../core/run-helpers';
import { runPlanner } from '../../core/run-plan';
import {
  createWorktree,
  installDependencies,
  normalizeClaudeSettings,
} from '../../git/worktree';
import { writeQueueRequest } from '../../state/queue';
import { promptLocalTaskInput } from '../../task/prompt-local-task';
import { type LocalTaskInput, parseLocalTaskFile } from '../../task/providers/local';
import { inferTaskRefFromBranch, resolveTask } from '../../task/resolve';
import { buildWorktreeName } from '../../utils/worktree-name';
import { parseAnswerPairs } from '../answers';
import { emitJsonSuccess } from '../json-output';
import { createCliLogger } from '../logger';
import { renderSuccessSummary } from '../output';
import {
  renderClarifications,
  renderNextSteps,
  renderPlanSummary,
  renderReadySection,
  renderTaskHeader,
  summarizePlan,
} from '../task-start-output';
import type { CliOptions } from '../types';

export type TaskCommandDeps = {
  withCliContext: <T>(
    options: CliOptions,
    mode: 'json' | 'headless',
    fn: (ctx: RunContext) => Promise<T>,
  ) => Promise<T>;
  withAgentSessions: <T>(
    persist: boolean,
    fn: (sessions: SessionPool | undefined) => Promise<T>,
  ) => Promise<T>;
  parseQueuePriority: (value: string | undefined, fallback: number) => number;
};

export function registerTaskCommands(cli: CAC, deps: TaskCommandDeps): void {
  cli
    .command(
      'task start [taskRef]',
      'Start a task (accepts: Linear ID like "ENG-123", GitHub issue like "gh-42" or URL, or local title)',
    )
    .option('--title <title>', 'Task title for local tasks')
    .option('--desc <desc>', 'Task description for local tasks')
    .option('--ac <criteria>', 'Acceptance criteria (can be used multiple times)')
    .option('--from-file <path>', 'Load task details from a markdown file')
    .option('--answer <pair>', 'Answer question (id=value)', { default: [] })
    .option('--priority <n>', 'Queue priority for this task (1-10)')
    .option('--queue', 'Add the task to the queue instead of starting immediately')
    .option('--plan-only', 'Generate plan without creating a worktree')
    .option('--print-cd', 'Print cd command to worktree (default: true)', {
      default: true,
    })
    .option('--open-shell', 'Open interactive shell in worktree')
    .option('--exec <cmd>', 'Run command in worktree then exit')
    .action((taskRef: string | undefined, options: CliOptions) =>
      deps.withCliContext(options, options.json ? 'json' : 'headless', async (ctx) => {
        const jsonMode = Boolean(options.json);
        const logger = createCliLogger(ctx);
        let localInput = await buildLocalTaskInput(options);
        let inferred =
          taskRef ??
          inferTaskRefFromBranch(ctx.repo.branch ?? '') ??
          localInput?.title ??
          '';

        if (!inferred) {
          if (!process.stdin.isTTY) {
            throw new SilvanError({
              code: 'task.missing_reference',
              message:
                'Task reference required. Provide a Linear ID, gh-<number>, GitHub issue URL, or a local title.',
              userMessage: 'Task reference required.',
              kind: 'validation',
              nextSteps: [
                'Provide a Linear ID, gh-<number>, GitHub issue URL, or a local title.',
                'Run `silvan help task-refs` for examples.',
              ],
            });
          }
          localInput = await promptLocalTaskInput();
          inferred = localInput.title;
        }

        const shouldQueue = Boolean(options.queue || options.priority);
        if (shouldQueue) {
          const priority = deps.parseQueuePriority(
            options.priority,
            ctx.config.queue.priority.default,
          );
          const request = {
            id: crypto.randomUUID(),
            type: 'start-task',
            title: inferred,
            ...(localInput?.description ? { description: localInput.description } : {}),
            ...(localInput?.acceptanceCriteria?.length
              ? { acceptanceCriteria: localInput.acceptanceCriteria }
              : {}),
            priority,
            createdAt: new Date().toISOString(),
          } satisfies Parameters<typeof writeQueueRequest>[0]['request'];
          const path = await writeQueueRequest({ state: ctx.state, request });
          if (jsonMode) {
            await emitJsonSuccess({
              command: 'task start',
              data: { queued: request, path },
              nextSteps: ['silvan queue run'],
              repoRoot: ctx.repo.repoRoot,
              runId: ctx.runId,
            });
            return;
          }
          if (!options.quiet) {
            await logger.info(
              renderSuccessSummary({
                title: 'Task queued',
                details: [
                  ['Request ID', request.id],
                  ['Priority', `${priority}`],
                  ['Title', request.title],
                  ['Path', path],
                ],
                nextSteps: ['silvan queue run', 'silvan queue status'],
              }),
            );
          }
          return;
        }

        await deps.withAgentSessions(
          Boolean(ctx.config.ai.sessions.persist),
          async (sessions) => {
            await startTaskFlow({
              ctx,
              ...(sessions ? { sessions } : {}),
              taskRef: inferred,
              ...(localInput ? { localInput } : {}),
              printCd: options.printCd !== false,
              answers: parseAnswerPairs(options.answer),
              planOnly: options.planOnly ?? false,
              skipPrompts: options.yes ?? false,
              ...(options.exec ? { exec: options.exec } : {}),
              ...(options.openShell ? { openShell: options.openShell } : {}),
            });
          },
        );
      }),
    );
}

async function buildLocalTaskInput(
  options: CliOptions,
): Promise<LocalTaskInput | undefined> {
  const acValues = Array.isArray(options.ac)
    ? options.ac
    : options.ac
      ? [options.ac]
      : [];
  const fromFile = options.fromFile?.trim();
  let input: LocalTaskInput | undefined;

  if (fromFile) {
    const contents = await Bun.file(fromFile).text();
    input = parseLocalTaskFile(contents);
  }

  if (!input && !options.title && !options.desc && acValues.length === 0) {
    return undefined;
  }

  const merged: LocalTaskInput = {
    title: options.title ?? input?.title ?? '',
    ...(options.desc
      ? { description: options.desc }
      : input?.description
        ? { description: input.description }
        : {}),
    ...(acValues.length > 0
      ? { acceptanceCriteria: acValues }
      : input?.acceptanceCriteria
        ? { acceptanceCriteria: input.acceptanceCriteria }
        : {}),
  };

  return merged;
}

export async function startTaskFlow(options: {
  ctx: RunContext;
  sessions?: SessionPool;
  taskRef: string;
  localInput?: LocalTaskInput;
  printCd: boolean;
  answers?: Record<string, string>;
  planOnly?: boolean;
  skipPrompts?: boolean;
  exec?: string;
  openShell?: boolean;
}): Promise<void> {
  const ctx = options.ctx;
  const mode = ctx.events.mode;
  let logger = createCliLogger(ctx);
  if (options.planOnly && (options.exec || options.openShell)) {
    throw new SilvanError({
      code: 'task.plan_only_conflict',
      message: 'Plan-only mode cannot open a worktree shell or run commands.',
      userMessage:
        'Plan-only mode does not create a worktree. Remove --plan-only to use --exec or --open-shell.',
      kind: 'validation',
      nextSteps: [
        `Run: silvan task start ${formatShellArg(options.taskRef)}`,
        'Or drop --plan-only to create a worktree.',
      ],
    });
  }

  const resolved = await runStep(ctx, 'task.resolve', 'Resolving task', () =>
    resolveTask(options.taskRef, {
      config: ctx.config,
      repoRoot: ctx.repo.repoRoot,
      state: ctx.state,
      runId: ctx.runId,
      ...(options.localInput ? { localInput: options.localInput } : {}),
      bus: ctx.events.bus,
      context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
    }),
  );

  await logger.info(renderTaskHeader(resolved.task));

  const providedAnswers = options.answers ?? {};
  const hasProvidedAnswers = Object.keys(providedAnswers).length > 0;

  let safeName: string | undefined;
  let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;

  if (!options.planOnly) {
    safeName = buildWorktreeName(resolved.task);
    worktree = await runStep(ctx, 'git.worktree.create', 'Creating worktree', async () =>
      createWorktree({
        repoRoot: ctx.repo.repoRoot,
        name: safeName ?? 'task',
        config: ctx.config,
        bus: ctx.events.bus,
        context: { runId: ctx.runId, repoRoot: ctx.repo.repoRoot, mode },
      }),
    );

    const worktreePath = worktree.path;
    ctx.repo.worktreePath = worktreePath;
    if (worktree.branch) {
      ctx.repo.branch = worktree.branch;
    }
    ctx.repo.isWorktree = true;
    logger = createCliLogger(ctx);

    await normalizeClaudeSettings({ worktreePath });

    const installResult = await runStep(
      ctx,
      'deps.install',
      'Installing dependencies',
      () => installDependencies({ worktreePath }),
    );
    if (!installResult.ok) {
      await logger.warn(`Warning: bun install failed in ${worktreePath}`, {
        stderr: installResult.stderr,
        stdout: installResult.stdout,
      });
    }
  }

  let plan = await runPlanner(ctx, {
    taskRef: resolved.ref.raw,
    task: resolved.task,
    ...(safeName ? { worktreeName: safeName } : {}),
    ...(hasProvidedAnswers ? { clarifications: providedAnswers } : {}),
    ...(options.sessions ? { sessions: options.sessions } : {}),
    allowMissingClarifications: true,
  });

  await logger.info(renderPlanSummary(summarizePlan(plan)));

  const questions = normalizeClarificationQuestions(plan.questions);
  if (questions.length > 0) {
    const promptAllowed =
      !options.skipPrompts && process.stdin.isTTY && ctx.events.mode !== 'json';
    if (promptAllowed) {
      await logger.info(
        renderClarifications(questions, {
          intro: 'The plan has questions that would help refine the implementation:',
        }),
      );
      const clarifications = await collectClarifications({
        questions,
        answers: providedAnswers,
      });
      const missingRequired = questions.filter(
        (question) =>
          question.required !== false &&
          (!clarifications[question.id] || clarifications[question.id]?.trim() === ''),
      );
      if (missingRequired.length > 0) {
        await logger.info(
          renderClarifications(missingRequired, {
            title: 'Clarifications Required',
            intro: 'This plan has required questions that must be answered:',
          }),
        );
        const requiredId = missingRequired[0]?.id ?? 'question-id';
        const needsInputNextSteps = [
          `silvan agent clarify --answer ${requiredId}=<value>`,
          'silvan agent clarify',
        ];
        await logger.info(renderNextSteps(needsInputNextSteps));
        await logger.info('Status: Needs input (exit code 0)');
        return;
      }

      const hasNewAnswers = Object.entries(clarifications).some(
        ([id, value]) => value.trim() && value.trim() !== providedAnswers[id],
      );
      if (hasNewAnswers) {
        plan = await runPlanner(ctx, {
          taskRef: resolved.ref.raw,
          task: resolved.task,
          ...(safeName ? { worktreeName: safeName } : {}),
          clarifications,
          ...(options.sessions ? { sessions: options.sessions } : {}),
          allowMissingClarifications: true,
        });
        await logger.info(
          renderPlanSummary(summarizePlan(plan), { title: 'Updated Plan' }),
        );
        const updatedQuestions = normalizeClarificationQuestions(plan.questions);
        const remainingRequired = updatedQuestions.filter(
          (question) =>
            question.required !== false &&
            (!clarifications[question.id] || clarifications[question.id]?.trim() === ''),
        );
        if (remainingRequired && remainingRequired.length > 0) {
          await logger.info(
            renderClarifications(remainingRequired, {
              title: 'Clarifications Required',
              intro: 'This plan has required questions that must be answered:',
            }),
          );
          const requiredId = remainingRequired[0]?.id ?? 'question-id';
          const needsInputNextSteps = [
            `silvan agent clarify --answer ${requiredId}=<value>`,
            'silvan agent clarify',
          ];
          await logger.info(renderNextSteps(needsInputNextSteps));
          await logger.info('Status: Needs input (exit code 0)');
          return;
        }
      }
    } else {
      const missingRequired = questions.filter(
        (question) =>
          question.required !== false &&
          (!providedAnswers[question.id] || providedAnswers[question.id]?.trim() === ''),
      );
      if (missingRequired.length > 0) {
        await logger.info(
          renderClarifications(questions, {
            title: 'Clarifications Required',
            intro: 'This plan has required questions that must be answered:',
          }),
        );
        const requiredId = missingRequired[0]?.id ?? 'question-id';
        const needsInputNextSteps = [
          `silvan agent clarify --answer ${requiredId}=<value>`,
          'silvan agent clarify',
        ];
        await logger.info(renderNextSteps(needsInputNextSteps));
        await logger.info('Status: Needs input (exit code 0)');
        return;
      }
    }
  }

  const readyTitle = options.planOnly ? 'Plan generated' : 'Ready to implement';
  await logger.info(
    renderReadySection({
      title: readyTitle,
      runId: ctx.runId,
      ...(worktree?.path ? { worktreePath: worktree.path } : {}),
    }),
  );

  const nextSteps: string[] = [];
  if (worktree?.path && options.printCd) {
    nextSteps.push(`cd ${worktree.path}`);
  }
  if (!options.planOnly) {
    nextSteps.push('silvan agent run --apply');
  } else {
    nextSteps.push(`silvan task start ${formatShellArg(resolved.ref.raw)}`);
  }

  const nextStepsBlock = renderNextSteps(nextSteps);
  if (nextStepsBlock) {
    await logger.info(nextStepsBlock);
  }

  if (options.exec && worktree) {
    runCommandInWorktree(options.exec, worktree.path);
  }
  if (options.openShell && worktree) {
    openShellInWorktree(worktree.path);
  }
}

function runCommandInWorktree(command: string, worktreePath: string): void {
  if (!command.trim()) return;
  const result = spawnSync(command, {
    cwd: worktreePath,
    stdio: 'inherit',
    shell: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exitCode = result.status;
  }
}

function openShellInWorktree(worktreePath: string): void {
  if (!process.stdin.isTTY) {
    throw new Error('Cannot open a shell without a TTY.');
  }
  const shell =
    process.platform === 'win32'
      ? (process.env['COMSPEC'] ?? 'powershell.exe')
      : (process.env['SHELL'] ?? '/bin/sh');
  const result = spawnSync(shell, {
    cwd: worktreePath,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw result.error;
  }
}

function normalizeClarificationQuestions(
  questions:
    | Array<{ id: string; text: string; required?: boolean | undefined }>
    | undefined,
): ClarificationQuestion[] {
  if (!questions) return [];
  return questions.map((question) => ({
    id: question.id,
    text: question.text,
    ...(question.required === undefined ? {} : { required: question.required }),
  }));
}

function formatShellArg(value: string): string {
  const trimmed = value.trim();
  if (!/[\s"'`]/.test(trimmed)) {
    return trimmed;
  }
  return `"${trimmed.replace(/(["\\])/g, '\\$1')}"`;
}
