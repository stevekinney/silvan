import type { ModelBenchmarkReport, ModelBenchmarkResult } from '../ai/model-benchmark';
import type { ModelRoutingReport } from '../ai/model-routing';
import { formatDurationMs } from '../utils/time';
import {
  colors,
  formatKeyValues,
  padLabel,
  renderNextSteps,
  renderSectionHeader,
  truncateText,
} from './output';

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatLatencyDelta(value: number): string {
  const direction = value >= 0 ? '+' : '-';
  const absValue = Math.abs(value);
  return `${direction}${Math.round(absValue * 100)}%`;
}

function renderConfigSnippet(report: ModelRoutingReport): string[] {
  const entries = Object.entries(report.configSnippet.ai.cognition.modelByTask);
  if (entries.length === 0) {
    return ['  (no config changes)'];
  }
  const lines = ['ai:', '  cognition:', '    modelByTask:'];
  for (const [task, model] of entries) {
    lines.push(`      ${task}: ${model}`);
  }
  return lines;
}

export function renderModelRoutingReport(options: {
  report: ModelRoutingReport;
  autoApply: boolean;
  minSamples: number;
}): string {
  const { report } = options;
  const lines: string[] = [];
  lines.push(renderSectionHeader('Model routing recommendations', { width: 60 }));
  lines.push(
    ...formatKeyValues(
      [
        ['Lookback', `${report.lookbackDays}d`],
        ['Sessions', String(report.totalSessions)],
        ['Tasks', String(report.tasksEvaluated)],
        ['Models', String(report.modelsEvaluated)],
        [
          'Auto-apply',
          report.recommendations.length === 0 ? 'n/a' : options.autoApply ? 'on' : 'off',
        ],
        ['Min samples', String(options.minSamples)],
      ],
      { labelWidth: 14 },
    ),
  );

  lines.push('');
  lines.push(renderSectionHeader('Recommendations', { width: 60, kind: 'minor' }));

  if (report.recommendations.length === 0) {
    lines.push('No model recommendations available yet.');
  } else {
    const labelWidth = 18;
    for (const rec of report.recommendations) {
      const header = `${padLabel(rec.task, labelWidth)} ${rec.recommendedModel}`;
      lines.push(header);
      const details = `${' '.repeat(labelWidth)} from ${rec.baselineModel} · success ${formatPercent(rec.successRate)} (base ${formatPercent(rec.baselineSuccessRate)}) · latency ${formatLatencyDelta(rec.latencyDeltaRatio)} · samples ${rec.sampleCount}`;
      lines.push(details);
    }
  }

  lines.push('');
  lines.push(renderSectionHeader('Config snippet', { width: 60, kind: 'minor' }));
  lines.push(...renderConfigSnippet(report));

  const nextSteps = [
    'silvan models benchmark --models <model-a,model-b>',
    'silvan config show',
  ];
  lines.push(renderNextSteps(nextSteps));

  return lines.join('\n');
}

function renderBenchmarkResult(
  result: ModelBenchmarkResult,
  labelWidth: number,
): string[] {
  const statusLabel = result.ok ? colors.success('ok') : colors.error('fail');
  const duration = formatDurationMs(result.durationMs);
  const headline = `${padLabel(result.model, labelWidth)} ${statusLabel} ${duration}`;
  const details: string[] = [headline];
  if (result.error) {
    details.push(`${' '.repeat(labelWidth)} ${truncateText(result.error, 80)}`);
  } else if (result.summary) {
    details.push(`${' '.repeat(labelWidth)} ${truncateText(result.summary, 80)}`);
  }
  return details;
}

export function renderModelBenchmarkReport(report: ModelBenchmarkReport): string {
  const lines: string[] = [];
  lines.push(renderSectionHeader('Model benchmark', { width: 60 }));
  lines.push(
    ...formatKeyValues(
      [
        ['Task', report.task.title],
        ['Models', String(report.results.length)],
        ['Provider', report.provider],
      ],
      { labelWidth: 14 },
    ),
  );

  lines.push('');
  lines.push(renderSectionHeader('Results', { width: 60, kind: 'minor' }));
  if (report.results.length === 0) {
    lines.push('No benchmark results.');
  } else {
    const labelWidth = 18;
    for (const result of report.results) {
      lines.push(...renderBenchmarkResult(result, labelWidth));
    }
  }

  const nextSteps = ['silvan models recommend', 'silvan config show'];
  lines.push(renderNextSteps(nextSteps));

  return lines.join('\n');
}
