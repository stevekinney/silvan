import type { ClarificationQuestion } from '../agent/clarify';
import type { Plan } from '../agent/schemas';
import type { Task } from '../task/types';
import {
  formatKeyList,
  formatKeyValues,
  renderNextSteps,
  renderSectionHeader,
} from './output';

const LINE_WIDTH = 60;
const LABEL_WIDTH = 12;

export type PlanSummary = {
  summary: string;
  steps: number;
  files: string[];
  risks: string[];
  complexity: 'Low' | 'Medium' | 'High';
};

export function summarizePlan(plan: Plan): PlanSummary {
  const files = new Set<string>();
  const risks = new Set<string>();

  for (const step of plan.steps) {
    for (const file of step.files ?? []) {
      if (file.trim()) files.add(file.trim());
    }
    for (const risk of step.risks ?? []) {
      if (risk.trim()) risks.add(risk.trim());
    }
  }

  const steps = plan.steps.length;
  return {
    summary: plan.summary,
    steps,
    files: Array.from(files).sort(),
    risks: Array.from(risks).sort(),
    complexity: deriveComplexity(steps),
  };
}

export function renderTaskHeader(task: Task): string {
  const lines: string[] = [];
  lines.push(
    renderSectionHeader(`Task: ${task.title}`, { width: LINE_WIDTH, kind: 'major' }),
  );

  const details: Array<[string, string]> = [];
  const ref = task.key ?? task.id;
  details.push(['Ref', `${ref} (${formatProvider(task.provider)})`]);

  const source = describeTaskSource(task);
  if (source) details.push(['Source', source]);
  if (task.url) details.push(['URL', task.url]);
  if (task.labels.length > 0) details.push(['Labels', task.labels.join(', ')]);
  if (task.assignee) details.push(['Assignee', task.assignee]);
  if (task.state) details.push(['Status', task.state]);

  lines.push(...formatKeyValues(details, { labelWidth: LABEL_WIDTH }));
  return lines.join('\n');
}

export function renderPlanSummary(
  planSummary: PlanSummary,
  options?: { title?: string },
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    renderSectionHeader(options?.title ?? 'Plan Summary', {
      width: LINE_WIDTH,
      kind: 'minor',
    }),
  );

  lines.push(
    ...formatKeyValues([['Summary', planSummary.summary]], { labelWidth: LABEL_WIDTH }),
  );
  lines.push(
    ...formatKeyValues(
      [
        [
          'Steps',
          `${planSummary.steps} implementation step${planSummary.steps === 1 ? '' : 's'}`,
        ],
      ],
      { labelWidth: LABEL_WIDTH },
    ),
  );

  if (planSummary.files.length > 0) {
    lines.push(
      ...formatKeyList(
        'Files',
        `${planSummary.files.length} file${
          planSummary.files.length === 1 ? '' : 's'
        } to create/modify`,
        planSummary.files,
        { labelWidth: LABEL_WIDTH },
      ),
    );
  } else {
    lines.push(
      ...formatKeyValues([['Files', 'None listed']], { labelWidth: LABEL_WIDTH }),
    );
  }

  lines.push(
    ...formatKeyValues([['Complexity', planSummary.complexity]], {
      labelWidth: LABEL_WIDTH,
    }),
  );

  if (planSummary.risks.length > 0) {
    lines.push(
      ...formatKeyList(
        'Risks',
        `${planSummary.risks.length} risk${planSummary.risks.length === 1 ? '' : 's'}`,
        planSummary.risks,
        { labelWidth: LABEL_WIDTH },
      ),
    );
  } else {
    lines.push(
      ...formatKeyValues([['Risks', 'None identified']], { labelWidth: LABEL_WIDTH }),
    );
  }

  return lines.join('\n');
}

export function renderClarifications(
  questions: ClarificationQuestion[],
  options?: { title?: string; intro?: string },
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    renderSectionHeader(options?.title ?? 'Clarifications Needed', {
      width: LINE_WIDTH,
      kind: 'minor',
    }),
  );

  if (options?.intro) {
    lines.push(options.intro);
    lines.push('');
  }

  questions.forEach((question, index) => {
    lines.push(`${index + 1}. [${question.id}] ${question.text}`);
    lines.push(`   Required: ${question.required === false ? 'No' : 'Yes'}`);
  });

  return lines.join('\n');
}

export function renderReadySection(options: {
  title: string;
  runId: string;
  worktreePath?: string;
}): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(renderSectionHeader(options.title, { width: LINE_WIDTH, kind: 'minor' }));

  const details: Array<[string, string]> = [];
  if (options.worktreePath) {
    details.push(['Worktree', options.worktreePath]);
  }
  details.push(['Run ID', options.runId]);

  lines.push(...formatKeyValues(details, { labelWidth: LABEL_WIDTH }));
  return lines.join('\n');
}

export { renderNextSteps };

function deriveComplexity(stepCount: number): PlanSummary['complexity'] {
  if (stepCount <= 3) return 'Low';
  if (stepCount <= 6) return 'Medium';
  return 'High';
}

function formatProvider(provider: Task['provider']): string {
  switch (provider) {
    case 'github':
      return 'GitHub';
    case 'linear':
      return 'Linear';
    case 'local':
      return 'Local';
    default:
      return provider;
  }
}

function describeTaskSource(task: Task): string | undefined {
  if (task.provider === 'github') {
    const meta = task.metadata as
      | { owner?: string; repo?: string; number?: number }
      | undefined;
    if (meta?.owner && meta.repo && meta.number) {
      return `GitHub issue ${meta.owner}/${meta.repo}#${meta.number}`;
    }
    return 'GitHub issue';
  }

  if (task.provider === 'linear') {
    const meta = task.metadata as { teamKey?: string } | undefined;
    if (meta?.teamKey) {
      return `Linear ${meta.teamKey}`;
    }
    return 'Linear ticket';
  }

  return undefined;
}
