import type {
  AnalyticsFailureSummary,
  AnalyticsPhaseSummary,
  AnalyticsReport,
} from '../analytics/analytics';
import { formatDurationMs } from '../utils/time';
import {
  formatKeyList,
  formatKeyValues,
  renderNextSteps,
  renderSectionHeader,
} from './output';

const LABEL_WIDTH = 22;
const MAX_FAILURES = 5;

export function renderAnalyticsReport(report: AnalyticsReport): string {
  const lines: string[] = [];

  lines.push(renderSectionHeader('Run analytics'));

  if (report.summary.runsStarted === 0) {
    lines.push(...formatKeyValues([['Runs', '0']], { labelWidth: LABEL_WIDTH }));
    lines.push(renderNextSteps(buildAnalyticsNextSteps(report)));
    return lines.join('\n');
  }

  lines.push(...renderSummary(report));

  const filterLines = renderFilters(report);
  if (filterLines.length > 0) {
    lines.push('');
    lines.push(renderSectionHeader('Filters'));
    lines.push(...filterLines);
  }

  const phaseLines = renderPhaseAverages(report);
  if (phaseLines.length > 0) {
    lines.push('');
    lines.push(renderSectionHeader('Phase averages'));
    lines.push(...phaseLines);
  }

  const failureLines = renderFailureReasons(report);
  if (failureLines.length > 0) {
    lines.push('');
    lines.push(renderSectionHeader('Failure reasons'));
    lines.push(...failureLines);
  }

  lines.push(renderNextSteps(buildAnalyticsNextSteps(report)));
  return lines.join('\n');
}

export function buildAnalyticsNextSteps(report: AnalyticsReport): string[] {
  const steps: string[] = [];
  if (report.summary.runsFailed > 0) {
    steps.push('silvan run list --status failed');
  }
  if (report.summary.runsRunning > 0) {
    steps.push('silvan run list --status blocked');
  }
  const sampleRun = report.failures[0]?.sampleRuns[0];
  if (sampleRun) {
    steps.push(`silvan logs ${sampleRun}`);
  }
  if (steps.length === 0) {
    steps.push('silvan run list');
  }
  return steps.slice(0, 3);
}

function renderSummary(report: AnalyticsReport): string[] {
  const summary = report.summary;
  const successRate = formatRate(summary.runsConverged, summary.runsFinished);
  const averageDuration =
    summary.avgTimeToConvergenceMs === null
      ? 'n/a'
      : formatDurationMs(summary.avgTimeToConvergenceMs);

  return formatKeyValues(
    [
      ['Runs started', `${summary.runsStarted}`],
      ['Runs finished', `${summary.runsFinished}`],
      ['Runs running', `${summary.runsRunning}`],
      ['Runs converged', `${summary.runsConverged}`],
      ['Runs failed', `${summary.runsFailed}`],
      ['Runs aborted', `${summary.runsAborted}`],
      ['Success rate', successRate],
      ['Avg time to converge', averageDuration],
    ],
    { labelWidth: LABEL_WIDTH },
  );
}

function renderFilters(report: AnalyticsReport): string[] {
  const filters = report.filters;
  const entries: Array<[string, string]> = [];
  if (filters.since) {
    entries.push(['Since', filters.since]);
  }
  if (filters.until) {
    entries.push(['Until', filters.until]);
  }
  if (filters.providers && filters.providers.length > 0) {
    entries.push(['Providers', filters.providers.join(', ')]);
  }
  if (filters.repos && filters.repos.length > 0) {
    entries.push(['Repos', filters.repos.join(', ')]);
  }
  return entries.length > 0 ? formatKeyValues(entries, { labelWidth: LABEL_WIDTH }) : [];
}

function renderPhaseAverages(report: AnalyticsReport): string[] {
  if (report.phases.length === 0) return [];
  const totalFailures = report.summary.runsFailed;
  const entries = report.phases.map((phase) => [
    phase.phase,
    formatPhaseSummary(phase, totalFailures),
  ]) satisfies Array<[string, string]>;
  return formatKeyValues(entries, { labelWidth: LABEL_WIDTH });
}

function formatPhaseSummary(phase: AnalyticsPhaseSummary, totalFailures: number): string {
  const average = formatDurationMs(phase.avgDurationMs);
  const base = `${average} avg over ${phase.sampleCount} run(s)`;
  if (phase.failureCount === 0 || totalFailures === 0) {
    return base;
  }
  const failureShare = formatRate(phase.failureCount, totalFailures);
  return `${base}, failures: ${phase.failureCount} (${failureShare})`;
}

function renderFailureReasons(report: AnalyticsReport): string[] {
  if (report.failures.length === 0) {
    return formatKeyValues([['Failures', 'none']], { labelWidth: LABEL_WIDTH });
  }

  const failures = report.failures.slice(0, MAX_FAILURES);
  const items = failures.map((failure) => formatFailure(failure));
  const summary = `${report.failures.length} reason(s)`;
  return formatKeyList('Top failures', summary, items, { labelWidth: LABEL_WIDTH });
}

function formatFailure(failure: AnalyticsFailureSummary): string {
  const phase = failure.phase ? ` (phase: ${failure.phase})` : '';
  const samples =
    failure.sampleRuns.length > 0 ? ` [runs: ${failure.sampleRuns.join(', ')}]` : '';
  return `${failure.count}x ${failure.reason}${phase}${samples}`;
}

function formatRate(numerator: number, denominator: number): string {
  if (denominator === 0) return 'n/a';
  const pct = Math.round((numerator / denominator) * 100);
  return `${pct}% (${numerator}/${denominator})`;
}
