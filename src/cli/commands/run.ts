import type { CAC } from 'cac';

import { loadConfig } from '../../config/load';
import type { ConfigInput } from '../../config/schema';
import type { RunContext } from '../../core/context';
import { detectRepoContext } from '../../core/repo';
import { resumeRun } from '../../core/run-controller';
import type { EventMode } from '../../events/schema';
import {
  deriveConvergenceFromSnapshot,
  loadRunSnapshot,
  markRunAborted,
  writeOverrideArtifact,
} from '../../run/controls';
import { initStateStore } from '../../state/store';
import { emitJsonSuccess } from '../json-output';
import { createCliLogger } from '../logger';
import {
  formatKeyList,
  formatKeyValues,
  formatStatusLabel,
  renderSectionHeader,
  renderSuccessSummary,
} from '../output';
import { renderRunListMinimal, renderRunListTable } from '../run-list-output';
import { renderNextSteps } from '../task-start-output';
import type { CliOptions } from '../types';
import {
  applyRunListFilters,
  buildRunListJson,
  buildRunListNextSteps,
  buildRunListRenderOptions,
  collectRunListEntries,
  loadRunListContext,
  resolveRunListFormat,
  resolveRunListPaging,
} from './run-list';

export type RunCommandDeps = {
  withCliContext: <T>(
    options: CliOptions | undefined,
    mode: EventMode,
    fn: (ctx: RunContext) => Promise<T>,
    extra?: { lock?: boolean; runId?: string; modelRouting?: boolean },
  ) => Promise<T>;
  withAgentSessions: <T>(
    enabled: boolean,
    fn: (
      sessions: ReturnType<typeof import('../../agent/session').createSessionPool>,
    ) => Promise<T>,
  ) => Promise<T>;
  buildConfigOverrides: (options: CliOptions) => ConfigInput;
  parseListFlag: (value: string | undefined) => string[] | null;
  parseNumberFlag: (value: string | undefined) => number | null;
};

export function registerRunCommands(cli: CAC, deps: RunCommandDeps): void {
  cli
    .command('run list', 'List all recorded runs')
    .option('--format <format>', 'table, minimal, or json', { default: 'table' })
    .option('--status <status>', 'Filter by status (comma-separated)')
    .option('--phase <phase>', 'Filter by phase (comma-separated)')
    .option('--source <source>', 'Filter by task source (comma-separated)')
    .option('--limit <n>', 'Number of runs to show', { default: '20' })
    .option('--offset <n>', 'Skip the first N runs', { default: '0' })
    .option('--show-source', 'Include task source column')
    .action(
      async (
        options: CliOptions & {
          format?: string;
          status?: string;
          phase?: string;
          source?: string;
          limit?: string;
          offset?: string;
          showSource?: boolean;
        },
      ) => {
        const { state, repoRoot } = await loadRunListContext(options, deps);
        const runs = await collectRunListEntries(state);
        const status = deps.parseListFlag(options.status);
        const phase = deps.parseListFlag(options.phase);
        const source = deps.parseListFlag(options.source);
        const filters = {
          ...(status ? { status } : {}),
          ...(phase ? { phase } : {}),
          ...(source ? { source } : {}),
        };
        const filtered = applyRunListFilters(runs, filters);
        const paging = resolveRunListPaging(filtered, runs.length, options, deps);
        const format = resolveRunListFormat(options.format, options.json);

        if (format === 'json') {
          await emitJsonSuccess({
            command: 'run list',
            data: buildRunListJson(paging),
            nextSteps: buildRunListNextSteps(paging.paged),
            repoRoot,
          });
          return;
        }

        if (options.quiet) {
          return;
        }

        if (format === 'minimal') {
          console.log(renderRunListMinimal(paging.paged));
          return;
        }

        console.log(
          renderRunListTable(
            paging.paged,
            buildRunListRenderOptions(filters, paging, Boolean(options.showSource)),
          ),
        );
      },
    );

  cli
    .command('run inspect <runId>', 'Inspect a run snapshot')
    .action(async (runId: string, options: CliOptions) => {
      const { state, repoRoot } = await loadRunSnapshotForCli(runId, options, deps);
      const snapshot = await state.readRunState(runId);
      if (!snapshot) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (options.json) {
        await emitJsonSuccess({
          command: 'run inspect',
          data: { snapshot },
          repoRoot,
          runId,
        });
        return;
      }
      if (options.quiet) {
        return;
      }
      const data = snapshot.data as Record<string, unknown>;
      const task = (
        typeof data['task'] === 'object' && data['task'] ? data['task'] : {}
      ) as {
        id?: string;
        key?: string;
        title?: string;
        provider?: string;
        acceptanceCriteria?: string[];
      };
      const run = (typeof data['run'] === 'object' && data['run'] ? data['run'] : {}) as {
        status?: string;
        phase?: string;
        updatedAt?: string;
      };
      const acCount = Array.isArray(task.acceptanceCriteria)
        ? task.acceptanceCriteria.length
        : 0;

      const lines: string[] = [];
      lines.push(renderSectionHeader('Run snapshot', { width: 60, kind: 'minor' }));
      lines.push(
        ...formatKeyValues(
          [
            ['Run ID', snapshot.runId],
            ['Status', formatStatusLabel(run.status ?? 'unknown')],
            ['Phase', run.phase ?? 'unknown'],
            ['Updated', run.updatedAt ?? 'n/a'],
          ],
          { labelWidth: 12 },
        ),
      );
      lines.push(
        ...formatKeyValues([['State file', `${snapshot.runId}.json`]], {
          labelWidth: 12,
        }),
      );

      if (task.id || task.title) {
        lines.push('');
        lines.push(renderSectionHeader('Task', { width: 60, kind: 'minor' }));
        lines.push(
          ...formatKeyValues(
            [
              ['Ref', task.key ?? task.id ?? 'unknown'],
              ['Title', task.title ?? 'Untitled'],
              ['Provider', task.provider ?? 'unknown'],
              ['Criteria', `${acCount} item(s)`],
            ],
            { labelWidth: 12 },
          ),
        );
      }

      lines.push(
        renderNextSteps([`silvan run status ${runId}`, `silvan run explain ${runId}`]),
      );
      console.log(lines.join('\n'));
    });

  cli
    .command('run status <runId>', 'Show convergence status for a run')
    .action(async (runId: string, options: CliOptions) => {
      const { snapshot, repoRoot } = await loadRunSnapshotForCli(runId, options, deps);
      const convergence = deriveConvergenceFromSnapshot(snapshot);
      if (options.json) {
        await emitJsonSuccess({
          command: 'run status',
          data: {
            runId,
            status: convergence.status,
            reasonCode: convergence.reasonCode,
            message: convergence.message,
            nextActions: convergence.nextActions,
            blockingArtifacts: convergence.blockingArtifacts ?? [],
          },
          repoRoot,
          runId,
        });
        return;
      }
      if (options.quiet) {
        return;
      }
      const lines: string[] = [];
      lines.push(renderSectionHeader('Run status', { width: 60, kind: 'minor' }));
      lines.push(
        ...formatKeyValues(
          [
            ['Run ID', runId],
            ['Status', formatStatusLabel(convergence.status)],
            ['Reason', convergence.reasonCode],
          ],
          { labelWidth: 12 },
        ),
      );
      lines.push(`Message: ${convergence.message}`);
      if (convergence.blockingArtifacts?.length) {
        lines.push(
          ...formatKeyList(
            'Blocking',
            `${convergence.blockingArtifacts.length} artifact(s)`,
            convergence.blockingArtifacts,
            { labelWidth: 12 },
          ),
        );
      }
      if (convergence.nextActions.length) {
        lines.push(
          ...formatKeyList(
            'Next actions',
            `${convergence.nextActions.length} action(s)`,
            convergence.nextActions,
            { labelWidth: 12 },
          ),
        );
      }
      lines.push(
        renderNextSteps([`silvan run explain ${runId}`, `silvan run resume ${runId}`]),
      );
      console.log(lines.join('\n'));
    });

  cli
    .command('run explain <runId>', 'Explain why a run is waiting or blocked')
    .action(async (runId: string, options: CliOptions) => {
      const { snapshot, repoRoot } = await loadRunSnapshotForCli(runId, options, deps);
      const explain = buildRunExplainData(snapshot);

      if (options.json) {
        await emitJsonSuccess({
          command: 'run explain',
          data: buildRunExplainJson(runId, explain),
          repoRoot,
          runId,
        });
        return;
      }
      if (options.quiet) {
        return;
      }
      console.log(buildRunExplainLines(runId, explain).join('\n'));
    });

  cli
    .command('run resume <runId>', 'Resume a run using convergence rules')
    .option('--dry-run', 'Allow only read-only tools')
    .option('--apply', 'Allow mutating tools')
    .option('--dangerous', 'Allow dangerous tools (requires --apply)')
    .action(async (runId: string, options: CliOptions) => {
      const { snapshot, repoRoot } = await loadRunSnapshotForCli(runId, options, deps);
      const convergence = deriveConvergenceFromSnapshot(snapshot);
      if (convergence.status === 'converged' || convergence.status === 'aborted') {
        if (options.json) {
          await emitJsonSuccess({
            command: 'run resume',
            data: {
              runId,
              status: convergence.status,
              reason: convergence.reasonCode,
              message: 'Resume is not applicable.',
            },
            repoRoot,
            runId,
          });
          return;
        }
        if (!options.quiet) {
          console.log(
            renderSuccessSummary({
              title: 'Resume not applicable',
              details: [
                ['Run ID', runId],
                ['Status', convergence.status],
                ['Reason', convergence.reasonCode],
              ],
              nextSteps: [`silvan run status ${runId}`, 'silvan run list'],
            }),
          );
        }
        return;
      }
      await deps.withCliContext(
        options,
        options.json ? 'json' : 'headless',
        async (ctx) => {
          const logger = createCliLogger(ctx);
          await deps.withAgentSessions(
            Boolean(ctx.config.ai.sessions.persist),
            async (sessions) => {
              const runOptions = {
                ...(options.dryRun ? { dryRun: true } : {}),
                ...(options.apply ? { apply: true } : {}),
                ...(options.dangerous ? { dangerous: true } : {}),
                sessions,
              };
              await resumeRun(ctx, runOptions);
            },
          );
          await logger.info(
            renderSuccessSummary({
              title: 'Run resumed',
              details: [['Run ID', runId]],
              nextSteps: [`silvan run status ${runId}`, `silvan run explain ${runId}`],
            }),
          );
        },
        { runId },
      );
    });

  cli
    .command('run override <runId> <reason...>', 'Override a run gate with a reason')
    .action(async (runId: string, reason: string[], options: CliOptions) => {
      const message = reason.join(' ').trim();
      if (!message) {
        throw new Error('Override reason is required.');
      }
      const { state, repoRoot } = await loadRunSnapshotForCli(runId, options, deps);
      const entry = await writeOverrideArtifact({ state, runId, reason: message });
      if (options.json) {
        await emitJsonSuccess({
          command: 'run override',
          data: { runId, override: entry },
          repoRoot,
          runId,
        });
        return;
      }
      if (options.quiet) {
        return;
      }
      console.log(
        renderSuccessSummary({
          title: 'Override recorded',
          details: [
            ['Run ID', runId],
            ['Path', entry.path],
          ],
          nextSteps: [`silvan run resume ${runId}`, `silvan run status ${runId}`],
        }),
      );
    });

  cli
    .command('run abort <runId> [reason]', 'Abort a run and mark it as canceled')
    .action(async (runId: string, reason: string | undefined, options: CliOptions) => {
      const { state, repoRoot } = await loadRunSnapshotForCli(runId, options, deps);
      const entry = await markRunAborted({ state, runId, ...(reason ? { reason } : {}) });
      if (options.json) {
        await emitJsonSuccess({
          command: 'run abort',
          data: { runId, aborted: entry },
          repoRoot,
          runId,
        });
        return;
      }
      if (options.quiet) {
        return;
      }
      console.log(
        renderSuccessSummary({
          title: 'Run aborted',
          details: [
            ['Run ID', runId],
            ['Path', entry.path],
          ],
          nextSteps: ['silvan run list', `silvan run inspect ${runId}`],
        }),
      );
    });
}

type RunExplainThread = {
  threadId?: string;
  severity?: string;
  summary?: string;
  path?: string | null;
  line?: number | null;
  isOutdated?: boolean;
};

type ReviewerSuggestions = {
  users?: string[];
  teams?: string[];
  error?: string;
};

type ReviewResponseSummary = {
  requestedAt?: string;
  reviewers?: string[];
  respondedReviewers?: string[];
  pendingReviewers?: string[];
  avgResponseHours?: number;
};

type VerificationAssistSummary = {
  summary?: string;
  steps?: string[];
  context?: string;
  commands?: string[];
};

type LocalGateSummary = {
  ok?: boolean;
  blockers?: number;
  warnings?: number;
};

type RunExplainData = {
  run: { status?: string; phase?: string };
  summary: {
    prUrl?: string;
    ci?: string;
    unresolvedReviewCount?: number;
    blockedReason?: string;
  };
  reviewPriority: RunExplainThread[];
  reviewerSuggestions: ReviewerSuggestions;
  reviewResponseSummary: ReviewResponseSummary;
  verificationAssist?: VerificationAssistSummary;
  localGate: LocalGateSummary;
  convergence: ReturnType<typeof deriveConvergenceFromSnapshot>;
  lastStep: string | null;
};

function buildRunExplainData(
  snapshot: Awaited<ReturnType<typeof loadRunSnapshot>>,
): RunExplainData {
  const data = snapshot.data as Record<string, unknown>;
  const run = (typeof data['run'] === 'object' && data['run'] ? data['run'] : {}) as {
    status?: string;
    phase?: string;
  };
  const steps = (
    typeof data['steps'] === 'object' && data['steps'] ? data['steps'] : {}
  ) as Record<string, { status?: string; endedAt?: string }>;
  const summary = (
    typeof data['summary'] === 'object' && data['summary'] ? data['summary'] : {}
  ) as {
    prUrl?: string;
    ci?: string;
    unresolvedReviewCount?: number;
    blockedReason?: string;
  };
  const reviewPriority = Array.isArray(data['reviewThreadPriority'])
    ? (data['reviewThreadPriority'] as RunExplainThread[])
    : [];
  const reviewerSuggestions = (data['reviewerSuggestions'] as
    | ReviewerSuggestions
    | undefined) ?? {
    users: [],
    teams: [],
  };
  const reviewResponseSummary =
    (data['reviewResponseSummary'] as ReviewResponseSummary | undefined) ?? {};
  const verificationAssist = data['verificationAssistSummary'] as
    | VerificationAssistSummary
    | undefined;
  const localGate = (data['localGateSummary'] as LocalGateSummary | undefined) ?? {};
  const convergence = deriveConvergenceFromSnapshot(snapshot);
  const lastStep = findLastSuccessfulStep(steps) ?? null;

  return {
    run,
    summary,
    reviewPriority,
    reviewerSuggestions,
    reviewResponseSummary,
    localGate,
    convergence,
    lastStep,
    ...(verificationAssist ? { verificationAssist } : {}),
  };
}

function buildRunExplainJson(runId: string, explain: RunExplainData) {
  return {
    runId,
    run: { status: explain.run.status, phase: explain.run.phase },
    convergence: explain.convergence,
    lastSuccessfulStep: explain.lastStep,
    summaries: {
      ci: explain.summary.ci ?? null,
      unresolvedReviewCount: explain.summary.unresolvedReviewCount ?? null,
      blockedReason: explain.summary.blockedReason ?? null,
      localGate: explain.localGate,
      verificationAssist: explain.verificationAssist ?? null,
    },
    review: {
      priorityThreads: explain.reviewPriority,
      reviewerSuggestions: explain.reviewerSuggestions,
      responseSummary: explain.reviewResponseSummary,
    },
  };
}

function buildRunExplainLines(runId: string, explain: RunExplainData): string[] {
  const lines: string[] = [];
  lines.push(renderSectionHeader('Run explanation', { width: 60, kind: 'minor' }));
  appendRunExplainBasics(lines, runId, explain);
  appendRunExplainConvergence(lines, explain);
  appendRunExplainSummary(lines, explain);
  appendReviewPrioritySection(lines, explain.reviewPriority);
  appendReviewerSuggestionsSection(lines, explain.reviewerSuggestions);
  appendReviewResponseSection(lines, explain.reviewResponseSummary);
  appendVerificationAssistSection(lines, explain.verificationAssist);
  appendLocalGateSection(lines, explain.localGate);
  appendBlockingArtifacts(lines, explain.convergence);
  appendNextActions(lines, explain.convergence);
  lines.push(
    renderNextSteps([`silvan run resume ${runId}`, `silvan run status ${runId}`]),
  );
  return lines;
}

function appendRunExplainBasics(lines: string[], runId: string, explain: RunExplainData) {
  lines.push(
    ...formatKeyValues(
      [
        ['Run ID', runId],
        ['Status', formatStatusLabel(explain.run.status ?? 'unknown')],
        ['Phase', explain.run.phase ?? 'unknown'],
      ],
      { labelWidth: 12 },
    ),
  );
}

function appendRunExplainConvergence(lines: string[], explain: RunExplainData) {
  lines.push(
    ...formatKeyValues(
      [
        ['Convergence', formatStatusLabel(explain.convergence.status)],
        ['Reason', explain.convergence.reasonCode],
      ],
      { labelWidth: 12 },
    ),
  );
  lines.push(`Message: ${explain.convergence.message}`);
  if (explain.lastStep) {
    lines.push(`Last successful step: ${explain.lastStep}`);
  }
}

function appendRunExplainSummary(lines: string[], explain: RunExplainData) {
  if (explain.summary.prUrl) {
    lines.push(`PR: ${explain.summary.prUrl}`);
  }
  if (explain.summary.ci) {
    lines.push(`CI: ${explain.summary.ci}`);
  }
  if (typeof explain.summary.unresolvedReviewCount === 'number') {
    lines.push(`Unresolved review comments: ${explain.summary.unresolvedReviewCount}`);
  }
  if (explain.summary.blockedReason) {
    lines.push(`Blocked reason: ${explain.summary.blockedReason}`);
  }
}

function appendReviewPrioritySection(
  lines: string[],
  reviewPriority: RunExplainThread[],
) {
  if (reviewPriority.length === 0) {
    return;
  }
  lines.push('');
  lines.push(renderSectionHeader('Review priorities', { width: 60, kind: 'minor' }));
  const list = reviewPriority.map((thread) => {
    const severity = thread.severity ?? 'unknown';
    const summaryText = thread.summary ?? thread.threadId ?? 'Thread';
    const location = thread.path
      ? `${thread.path}${thread.line ? `:${thread.line}` : ''}`
      : 'unknown location';
    return `${severity.toUpperCase()}: ${summaryText} (${location})`;
  });
  lines.push(
    ...formatKeyList('Threads', `${reviewPriority.length} item(s)`, list, {
      labelWidth: 12,
    }),
  );
}

function appendReviewerSuggestionsSection(
  lines: string[],
  reviewerSuggestions: ReviewerSuggestions,
) {
  const userCount = reviewerSuggestions.users?.length ?? 0;
  const teamCount = reviewerSuggestions.teams?.length ?? 0;
  if (!reviewerSuggestions.error && userCount === 0 && teamCount === 0) {
    return;
  }
  lines.push('');
  lines.push(renderSectionHeader('Reviewer suggestions', { width: 60, kind: 'minor' }));
  if (reviewerSuggestions.users?.length) {
    lines.push(
      ...formatKeyList(
        'Users',
        `${reviewerSuggestions.users.length} suggested`,
        reviewerSuggestions.users,
        { labelWidth: 12 },
      ),
    );
  }
  if (reviewerSuggestions.teams?.length) {
    lines.push(
      ...formatKeyList(
        'Teams',
        `${reviewerSuggestions.teams.length} suggested`,
        reviewerSuggestions.teams,
        { labelWidth: 12 },
      ),
    );
  }
  if (reviewerSuggestions.error) {
    lines.push(`Notes: ${reviewerSuggestions.error}`);
  }
}

function appendReviewResponseSection(
  lines: string[],
  reviewResponseSummary: ReviewResponseSummary,
) {
  if (!reviewResponseSummary.reviewers?.length) {
    return;
  }
  const respondedCount = reviewResponseSummary.respondedReviewers?.length ?? 0;
  const pendingCount = reviewResponseSummary.pendingReviewers?.length ?? 0;
  lines.push('');
  lines.push(renderSectionHeader('Reviewer responses', { width: 60, kind: 'minor' }));
  const responseDetails: Array<[string, string]> = [
    ['Requested', `${reviewResponseSummary.reviewers.length} reviewer(s)`],
    ['Responded', `${respondedCount} reviewer(s)`],
    ['Pending', `${pendingCount} reviewer(s)`],
  ];
  if (typeof reviewResponseSummary.avgResponseHours === 'number') {
    responseDetails.push([
      'Avg response',
      `${reviewResponseSummary.avgResponseHours.toFixed(1)}h`,
    ]);
  }
  lines.push(...formatKeyValues(responseDetails, { labelWidth: 12 }));
}

function appendVerificationAssistSection(
  lines: string[],
  verificationAssist: VerificationAssistSummary | undefined,
) {
  if (!verificationAssist?.summary && !verificationAssist?.steps?.length) {
    return;
  }
  lines.push('');
  lines.push(renderSectionHeader('Verification assist', { width: 60, kind: 'minor' }));
  const details: Array<[string, string]> = [];
  if (verificationAssist.context) {
    details.push(['Context', verificationAssist.context]);
  }
  if (verificationAssist.commands?.length) {
    details.push(['Commands', verificationAssist.commands.join(', ')]);
  }
  if (verificationAssist.summary) {
    details.push(['Summary', verificationAssist.summary]);
  }
  if (details.length > 0) {
    lines.push(...formatKeyValues(details, { labelWidth: 12 }));
  }
  if (verificationAssist.steps?.length) {
    lines.push(
      ...formatKeyList(
        'Steps',
        `${verificationAssist.steps.length} action(s)`,
        verificationAssist.steps,
        { labelWidth: 12 },
      ),
    );
  }
}

function appendLocalGateSection(lines: string[], localGate: LocalGateSummary) {
  if (localGate.ok !== false) {
    return;
  }
  lines.push(
    `Local gate: ${localGate.blockers ?? 0} blockers, ${localGate.warnings ?? 0} warnings`,
  );
}

function appendBlockingArtifacts(
  lines: string[],
  convergence: ReturnType<typeof deriveConvergenceFromSnapshot>,
) {
  if (!convergence.blockingArtifacts?.length) {
    return;
  }
  lines.push(
    ...formatKeyList(
      'Blocking',
      `${convergence.blockingArtifacts.length} artifact(s)`,
      convergence.blockingArtifacts,
      { labelWidth: 12 },
    ),
  );
}

function appendNextActions(
  lines: string[],
  convergence: ReturnType<typeof deriveConvergenceFromSnapshot>,
) {
  if (!convergence.nextActions.length) {
    return;
  }
  lines.push(
    ...formatKeyList(
      'Next actions',
      `${convergence.nextActions.length} action(s)`,
      convergence.nextActions,
      { labelWidth: 12 },
    ),
  );
}

async function loadRunSnapshotForCli(
  runId: string,
  options: CliOptions,
  deps: RunCommandDeps,
): Promise<{
  repoRoot: string;
  state: Awaited<ReturnType<typeof initStateStore>>;
  snapshot: Awaited<ReturnType<typeof loadRunSnapshot>>;
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
}> {
  const configResult = await loadConfig(deps.buildConfigOverrides(options), {
    cwd: process.cwd(),
  });
  const repo = await detectRepoContext({ cwd: configResult.projectRoot });
  const state = await initStateStore(repo.projectRoot, {
    lock: false,
    mode: configResult.config.state.mode,
    ...(configResult.config.state.root ? { root: configResult.config.state.root } : {}),
    metadataRepoRoot: repo.gitRoot,
  });
  const snapshot = await loadRunSnapshot(state, runId);
  return { repoRoot: repo.projectRoot, state, snapshot, config: configResult.config };
}

function findLastSuccessfulStep(
  steps: Record<string, { status?: string; endedAt?: string }>,
) {
  return Object.entries(steps)
    .filter(([, step]) => step?.status === 'done')
    .sort((a, b) => (b[1]?.endedAt ?? '').localeCompare(a[1]?.endedAt ?? ''))[0]?.[0];
}
