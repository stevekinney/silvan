import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { Phase } from '../../events/schema';
import type { ArtifactEntry } from '../../state/artifacts';
import { listArtifacts, readArtifact } from '../../state/artifacts';
import type { StateStore } from '../../state/store';
import { formatRelativeTime, formatTimestamp } from '../time';
import type { RunRecord } from '../types';

type UiArtifact = {
  id: string;
  stepId: string;
  name: string;
  kind: 'json' | 'text';
  updatedAt: string;
  sizeBytes?: number;
  path?: string;
  source: 'artifact' | 'state';
  entry?: ArtifactEntry;
  payload?: unknown;
};

type ArtifactPreview = {
  title: string;
  path?: string;
  formatter: string;
  lines: string[];
  totalLines: number;
  truncated: boolean;
};

type ArtifactGroup = {
  label: string;
  artifacts: UiArtifact[];
};

type QuickAccessItem = {
  key: string;
  label: string;
  predicate: (artifact: UiArtifact) => boolean;
};

const MAX_PREVIEW_LINES = 24;
const MAX_CACHE_LINES = 160;

const QUICK_ACCESS: QuickAccessItem[] = [
  {
    key: '1',
    label: 'Plan',
    predicate: (artifact) => artifact.id === 'state:plan',
  },
  {
    key: '2',
    label: 'Verify Report',
    predicate: (artifact) =>
      artifact.stepId === 'verify.run' && artifact.name === 'report',
  },
  {
    key: '3',
    label: 'Local Gate',
    predicate: (artifact) =>
      artifact.stepId === 'review.local_gate' && artifact.name === 'report',
  },
  {
    key: '4',
    label: 'AI Review',
    predicate: (artifact) =>
      artifact.stepId === 'review.ai_reviewer' && artifact.name === 'report',
  },
  {
    key: '5',
    label: 'PR Draft',
    predicate: (artifact) => artifact.stepId === 'pr.draft' && artifact.name === 'draft',
  },
];

export function ArtifactExplorer({
  run,
  stateStore,
  nowMs,
  active,
  onClose,
}: {
  run: RunRecord;
  stateStore: StateStore;
  nowMs: number;
  active: boolean;
  onClose: () => void;
}): React.ReactElement {
  const [artifacts, setArtifacts] = useState<UiArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [previewOffset, setPreviewOffset] = useState(0);
  const previewCache = useRef(new Map<string, ArtifactPreview>());

  const selected = artifacts[selectedIndex];
  const grouped = useMemo(() => groupArtifacts(artifacts), [artifacts]);
  const quickAccess = useMemo(
    () =>
      QUICK_ACCESS.map((item) => ({
        ...item,
        artifactIndex: artifacts.findIndex((artifact) => item.predicate(artifact)),
      })),
    [artifacts],
  );

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void loadArtifacts({ run, stateStore }).then((list) => {
      if (!mounted) return;
      setArtifacts(list);
      setSelectedIndex(0);
      setPreviewOpen(false);
      setPreview(null);
      setPreviewOffset(0);
      previewCache.current.clear();
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [run.runId, run.updatedAt, stateStore]);

  useEffect(() => {
    if (!previewOpen || !selected) {
      setPreview(null);
      setPreviewOffset(0);
      return;
    }
    const cached = previewCache.current.get(selected.id);
    if (cached) {
      setPreview(cached);
      setPreviewOffset(0);
      return;
    }
    let mounted = true;
    void loadPreview(selected, nowMs).then((next) => {
      if (!mounted) return;
      previewCache.current.set(selected.id, next);
      setPreview(next);
      setPreviewOffset(0);
    });
    return () => {
      mounted = false;
    };
  }, [nowMs, previewOpen, selected?.id, selected?.updatedAt]);

  useInput(
    (input, key) => {
      if (!active) return;
      if (input === 'v') {
        if (previewOpen) {
          setPreviewOpen(false);
          setPreviewOffset(0);
          return;
        }
        onClose();
        return;
      }
      if (key.escape || input === 'b') {
        if (previewOpen) {
          setPreviewOpen(false);
          setPreviewOffset(0);
          return;
        }
        onClose();
        return;
      }
      if (key.return) {
        if (selected) {
          setPreviewOpen((prev) => !prev);
          setPreviewOffset(0);
        }
        return;
      }

      const quickKey = quickAccess.find((item) => item.key === input);
      if (quickKey && quickKey.artifactIndex >= 0) {
        setSelectedIndex(quickKey.artifactIndex);
        setPreviewOpen(true);
        setPreviewOffset(0);
        return;
      }

      if (previewOpen) {
        if (key.downArrow || input === 'j') {
          setPreviewOffset((prev) => {
            if (!preview) return prev;
            const maxOffset = Math.max(0, preview.lines.length - MAX_PREVIEW_LINES);
            return Math.min(prev + 1, maxOffset);
          });
        }
        if (key.upArrow || input === 'k') {
          setPreviewOffset((prev) => Math.max(0, prev - 1));
        }
        return;
      }

      if (key.downArrow || input === 'j') {
        setSelectedIndex((prev) => Math.min(prev + 1, artifacts.length - 1));
      }
      if (key.upArrow || input === 'k') {
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      }
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Text>Artifacts</Text>
      <Text color="gray">
        {previewOpen ? 'Preview mode' : 'List mode'} | Enter preview | b back | v close
      </Text>

      <Box flexDirection="column">
        <Text color="gray">Quick Access</Text>
        <Text color="gray">
          {quickAccess
            .map((item) =>
              item.artifactIndex >= 0
                ? `[${item.key}] ${item.label}`
                : `[${item.key}] ${item.label} (missing)`,
            )
            .join('  ')}
        </Text>
      </Box>

      <Box flexDirection="column">
        <Text color="gray">All Artifacts ({artifacts.length})</Text>
        {loading ? (
          <Text color="gray">Loading artifacts...</Text>
        ) : artifacts.length === 0 ? (
          <Text color="gray">No artifacts recorded yet.</Text>
        ) : (
          grouped.map((group) => (
            <Box key={group.label} flexDirection="column" marginBottom={1}>
              <Text color="gray">{group.label}</Text>
              {group.artifacts.map((artifact) => {
                const isSelected = artifact.id === selected?.id;
                const fileName = `${artifact.name}.${artifact.kind === 'json' ? 'json' : 'txt'}`;
                const sizeLabel = artifact.sizeBytes
                  ? formatBytes(artifact.sizeBytes)
                  : '-';
                const updatedLabel = formatRelativeTime(artifact.updatedAt, nowMs);
                return (
                  <Box key={artifact.id} flexDirection="row" gap={1}>
                    <Text color={isSelected ? 'cyan' : 'gray'}>
                      {isSelected ? '>' : ' '}
                    </Text>
                    <Text>{fileName}</Text>
                    <Text color="gray">{artifact.kind}</Text>
                    <Text color="gray">{updatedLabel} ago</Text>
                    <Text color="gray">{sizeLabel}</Text>
                    <Text color="gray">{artifact.stepId}</Text>
                  </Box>
                );
              })}
            </Box>
          ))
        )}
      </Box>

      {previewOpen ? (
        <Box flexDirection="column" borderStyle="round" padding={1}>
          {preview ? (
            <>
              <Text>{preview.title}</Text>
              {preview.path ? <Text color="gray">Path: {preview.path}</Text> : null}
              <Text color="gray">
                {preview.formatter} |{' '}
                {preview.totalLines > 0
                  ? `Showing ${Math.min(
                      previewOffset + MAX_PREVIEW_LINES,
                      preview.totalLines,
                    )} of ${preview.totalLines} lines`
                  : 'No content'}
              </Text>
              <Box flexDirection="column" marginTop={1}>
                {preview.lines
                  .slice(previewOffset, previewOffset + MAX_PREVIEW_LINES)
                  .map((line, index) => (
                    <Text key={`${preview.title}-${index}`}>{line}</Text>
                  ))}
              </Box>
              {preview.truncated ? (
                <Text color="gray">
                  Truncated preview | {preview.totalLines} total lines
                </Text>
              ) : null}
            </>
          ) : (
            <Text color="gray">Loading preview...</Text>
          )}
        </Box>
      ) : null}
    </Box>
  );
}

async function loadArtifacts(options: {
  run: RunRecord;
  stateStore: StateStore;
}): Promise<UiArtifact[]> {
  const [state, entries] = await Promise.all([
    options.stateStore.readRunState(options.run.runId),
    listArtifacts({ state: options.stateStore, runId: options.run.runId }),
  ]);
  const artifacts: UiArtifact[] = [];
  for (const entry of entries) {
    const sizeBytes = safeSize(entry.path);
    const artifact: UiArtifact = {
      id: `${entry.stepId}:${entry.name}`,
      stepId: entry.stepId,
      name: entry.name,
      kind: entry.kind,
      updatedAt: entry.updatedAt,
      path: entry.path,
      source: 'artifact',
      entry,
    };
    if (typeof sizeBytes === 'number') {
      artifact.sizeBytes = sizeBytes;
    }
    artifacts.push(artifact);
  }

  const plan = state?.data ? (state.data['plan'] as Record<string, unknown>) : null;
  if (plan) {
    const payload = JSON.stringify(plan, null, 2);
    const artifact: UiArtifact = {
      id: 'state:plan',
      stepId: 'agent.plan.generate',
      name: 'plan',
      kind: 'json',
      updatedAt: options.run.updatedAt,
      sizeBytes: payload.length,
      path: buildRunStatePath(options.stateStore, options.run.runId),
      source: 'state',
      payload: plan,
    };
    artifacts.push(artifact);
  }

  return artifacts.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) {
      return b.updatedAt.localeCompare(a.updatedAt);
    }
    return a.name.localeCompare(b.name);
  });
}

async function loadPreview(
  artifact: UiArtifact,
  nowMs: number,
): Promise<ArtifactPreview> {
  if (artifact.source === 'state') {
    return formatJsonPreview(artifact, artifact.payload ?? {}, nowMs);
  }
  if (!artifact.entry || !artifact.path) {
    return {
      title: artifact.name,
      formatter: 'Missing artifact',
      lines: ['Artifact not available.'],
      totalLines: 1,
      truncated: false,
    };
  }
  if (artifact.kind === 'text') {
    const raw = await Bun.file(artifact.path).text();
    return formatTextPreview(artifact, raw);
  }
  try {
    const data = await readArtifact({ entry: artifact.entry });
    return formatJsonPreview(artifact, data, nowMs);
  } catch {
    const raw = await Bun.file(artifact.path).text();
    return formatTextPreview(artifact, raw);
  }
}

function formatTextPreview(artifact: UiArtifact, raw: string): ArtifactPreview {
  const lines = raw.split('\n');
  const previewLines = limitLines(lines);
  const preview: ArtifactPreview = {
    title: artifactTitle(artifact),
    formatter: `Raw text (${lines.length} lines)`,
    lines: previewLines,
    totalLines: lines.length,
    truncated: lines.length > previewLines.length,
  };
  if (artifact.path) {
    preview.path = artifact.path;
  }
  return preview;
}

function formatJsonPreview(
  artifact: UiArtifact,
  data: unknown,
  nowMs: number,
): ArtifactPreview {
  const { formatter, lines } = formatJsonArtifact(artifact, data, nowMs);
  const previewLines = limitLines(lines);
  const preview: ArtifactPreview = {
    title: artifactTitle(artifact),
    formatter,
    lines: previewLines,
    totalLines: lines.length,
    truncated: lines.length > previewLines.length,
  };
  if (artifact.path) {
    preview.path = artifact.path;
  }
  return preview;
}

function formatJsonArtifact(
  artifact: UiArtifact,
  data: unknown,
  nowMs: number,
): { formatter: string; lines: string[] } {
  const name = artifact.name;
  const step = artifact.stepId;
  if (artifact.id === 'state:plan') {
    return formatPlanPreview(data);
  }
  if (step === 'verify.run' && name === 'report') {
    return formatVerifyReportPreview(data);
  }
  if (step === 'review.local_gate' && name === 'report') {
    return formatLocalGatePreview(data);
  }
  if (step === 'pr.draft' && name === 'draft') {
    return formatPrDraftPreview(data);
  }
  if (step === 'review.classify' && name === 'classification') {
    return formatReviewClassificationPreview(data);
  }
  if (step === 'review.plan' && name === 'plan') {
    return formatReviewFixPlanPreview(data);
  }
  if (step === 'review.ai_reviewer' && name === 'report') {
    return formatAiReviewPreview(data);
  }
  if (step === 'ci.fix.plan' && name === 'plan') {
    return formatCiFixPlanPreview(data, nowMs);
  }
  return formatRawJsonPreview(data);
}

function formatPlanPreview(data: unknown): { formatter: string; lines: string[] } {
  const plan = data as {
    summary?: string;
    steps?: Array<{ title?: string; description?: string; files?: string[] }>;
    verification?: string[];
  };
  const lines: string[] = ['Plan Summary'];
  if (plan.summary) {
    lines.push(`Summary: ${plan.summary}`);
  }
  if (plan.steps?.length) {
    lines.push('');
    lines.push(`Steps (${plan.steps.length})`);
    plan.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.title ?? 'Untitled step'}`);
      if (step.description) {
        lines.push(`   ${step.description}`);
      }
      if (step.files?.length) {
        lines.push(`   Files: ${step.files.join(', ')}`);
      }
    });
  }
  if (plan.verification?.length) {
    lines.push('');
    lines.push('Verification');
    plan.verification.forEach((item) => lines.push(`- ${item}`));
  }
  return { formatter: 'Plan', lines };
}

function formatVerifyReportPreview(data: unknown): {
  formatter: string;
  lines: string[];
} {
  const report = data as {
    ok?: boolean;
    results?: Array<{
      name?: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    }>;
  };
  const lines: string[] = ['Verification Report'];
  lines.push(`Overall: ${report.ok ? 'Passed' : 'Failed'}`);
  if (report.results?.length) {
    lines.push('');
    lines.push('Commands');
    report.results.forEach((result) => {
      const status = result.exitCode === 0 ? 'OK' : 'FAIL';
      lines.push(
        `${status} ${result.name ?? 'unknown'} (exit ${result.exitCode ?? '-'})`,
      );
      const output = result.stderr?.trim() || result.stdout?.trim();
      if (output) {
        lines.push(...truncateOutput(output, 3).map((line) => `   ${line}`));
      }
    });
  }
  return { formatter: 'Verification report', lines };
}

function formatLocalGatePreview(data: unknown): { formatter: string; lines: string[] } {
  const report = data as {
    ok?: boolean;
    findings?: Array<{ severity?: string; title?: string; file?: string }>;
    stats?: { filesChanged?: number; linesAdded?: number; linesDeleted?: number };
    generatedAt?: string;
  };
  const lines: string[] = ['Local Gate Report'];
  lines.push(`Overall: ${report.ok ? 'Passed' : 'Failed'}`);
  if (report.stats) {
    lines.push(
      `Files ${report.stats.filesChanged ?? 0} | +${report.stats.linesAdded ?? 0} | -${report.stats.linesDeleted ?? 0}`,
    );
  }
  if (report.generatedAt) {
    lines.push(`Generated: ${report.generatedAt}`);
  }
  if (report.findings?.length) {
    lines.push('');
    lines.push(`Findings (${report.findings.length})`);
    report.findings.forEach((finding) => {
      const prefix = finding.severity ? finding.severity.toUpperCase() : 'INFO';
      const location = finding.file ? ` (${finding.file})` : '';
      lines.push(`${prefix} ${finding.title ?? 'Finding'}${location}`);
    });
  }
  return { formatter: 'Local gate', lines };
}

function formatPrDraftPreview(data: unknown): { formatter: string; lines: string[] } {
  const draft = data as {
    title?: string;
    body?: string;
    checklist?: string[];
    testing?: string[];
  };
  const lines: string[] = ['PR Draft'];
  if (draft.title) {
    lines.push(`Title: ${draft.title}`);
  }
  if (draft.body) {
    lines.push('');
    lines.push('Body');
    lines.push(...truncateOutput(draft.body, 6));
  }
  if (draft.checklist?.length) {
    lines.push('');
    lines.push('Checklist');
    draft.checklist.forEach((item) => lines.push(`- ${item}`));
  }
  if (draft.testing?.length) {
    lines.push('');
    lines.push('Testing');
    draft.testing.forEach((item) => lines.push(`- ${item}`));
  }
  return { formatter: 'PR draft', lines };
}

function formatReviewClassificationPreview(data: unknown): {
  formatter: string;
  lines: string[];
} {
  const report = data as {
    actionableThreadIds?: string[];
    ignoredThreadIds?: string[];
    needsContextThreadIds?: string[];
    clusters?: Array<{ summary?: string; threadIds?: string[] }>;
  };
  const lines: string[] = ['Review Classification'];
  const actionable = report.actionableThreadIds?.length ?? 0;
  const ignored = report.ignoredThreadIds?.length ?? 0;
  const needsContext = report.needsContextThreadIds?.length ?? 0;
  lines.push(
    `Actionable: ${actionable} | Ignored: ${ignored} | Needs context: ${needsContext}`,
  );
  if (report.clusters?.length) {
    lines.push('');
    lines.push('Clusters');
    report.clusters.forEach((cluster) => {
      lines.push(`- ${cluster.summary ?? 'Cluster'} (${cluster.threadIds?.length ?? 0})`);
    });
  }
  return { formatter: 'Review classification', lines };
}

function formatReviewFixPlanPreview(data: unknown): {
  formatter: string;
  lines: string[];
} {
  const plan = data as {
    threads?: Array<{ summary?: string; actionable?: boolean }>;
    verification?: string[];
  };
  const lines: string[] = ['Review Fix Plan'];
  if (plan.threads?.length) {
    lines.push(`Threads (${plan.threads.length})`);
    plan.threads.forEach((thread, index) => {
      const status = thread.actionable ? 'Actionable' : 'Optional';
      lines.push(`${index + 1}. ${thread.summary ?? 'Thread'} (${status})`);
    });
  }
  if (plan.verification?.length) {
    lines.push('');
    lines.push('Verification');
    plan.verification.forEach((item) => lines.push(`- ${item}`));
  }
  return { formatter: 'Review fix plan', lines };
}

function formatAiReviewPreview(data: unknown): { formatter: string; lines: string[] } {
  const report = data as { shipIt?: boolean; issues?: Array<{ note?: string }> };
  const lines: string[] = ['AI Review'];
  lines.push(`Ship it: ${report.shipIt ? 'Yes' : 'No'}`);
  if (report.issues?.length) {
    lines.push('');
    lines.push(`Issues (${report.issues.length})`);
    report.issues.forEach((issue) => {
      lines.push(`- ${issue.note ?? 'Issue'}`);
    });
  }
  return { formatter: 'AI review', lines };
}

function formatCiFixPlanPreview(
  data: unknown,
  nowMs: number,
): { formatter: string; lines: string[] } {
  const plan = data as { summary?: string; steps?: Array<{ title?: string }> };
  const lines: string[] = ['CI Fix Plan'];
  if (plan.summary) {
    lines.push(`Summary: ${plan.summary}`);
  }
  if (plan.steps?.length) {
    lines.push('');
    lines.push(`Steps (${plan.steps.length})`);
    plan.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.title ?? 'Step'}`);
    });
  }
  lines.push('');
  lines.push(`Generated: ${formatTimestamp(new Date(nowMs).toISOString())}`);
  return { formatter: 'CI fix plan', lines };
}

function formatRawJsonPreview(data: unknown): { formatter: string; lines: string[] } {
  try {
    const raw = JSON.stringify(data ?? null, null, 2);
    return { formatter: 'JSON', lines: raw.split('\n') };
  } catch {
    return { formatter: 'JSON', lines: ['Unable to render JSON'] };
  }
}

function groupArtifacts(artifacts: UiArtifact[]): ArtifactGroup[] {
  const groups = new Map<string, UiArtifact[]>();
  for (const artifact of artifacts) {
    const phase = derivePhase(artifact.stepId);
    const label = phaseLabel(phase);
    const list = groups.get(label) ?? [];
    list.push(artifact);
    groups.set(label, list);
  }
  const ordered = phaseOrder().filter((label) => groups.has(label));
  for (const [label] of groups) {
    if (!ordered.includes(label)) ordered.push(label);
  }
  return ordered.map((label) => ({
    label,
    artifacts: (groups.get(label) ?? []).sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) {
        return b.updatedAt.localeCompare(a.updatedAt);
      }
      return a.name.localeCompare(b.name);
    }),
  }));
}

function derivePhase(stepId: string): Phase | 'other' {
  const prefix = stepId.split('.')[0] ?? '';
  switch (prefix) {
    case 'agent':
    case 'plan':
      return 'plan';
    case 'verify':
      return 'verify';
    case 'review':
      return 'review';
    case 'ci':
      return 'ci';
    case 'pr':
    case 'github':
      return 'pr';
    case 'learning':
      return 'complete';
    default:
      return 'other';
  }
}

function phaseLabel(phase: Phase | 'other'): string {
  switch (phase) {
    case 'plan':
      return 'plan phase';
    case 'implement':
      return 'implement phase';
    case 'verify':
      return 'verify phase';
    case 'pr':
      return 'pr phase';
    case 'ci':
      return 'ci phase';
    case 'review':
      return 'review phase';
    case 'complete':
      return 'post-run';
    default:
      return 'other artifacts';
  }
}

function phaseOrder(): string[] {
  return [
    'plan phase',
    'implement phase',
    'verify phase',
    'pr phase',
    'ci phase',
    'review phase',
    'post-run',
    'other artifacts',
  ];
}

function artifactTitle(artifact: UiArtifact): string {
  const fileName = `${artifact.name}.${artifact.kind === 'json' ? 'json' : 'txt'}`;
  return fileName;
}

function truncateOutput(value: string, maxLines: number): string[] {
  const lines = value.split('\n');
  const trimmed = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    trimmed.push(`... (${lines.length - maxLines} more lines)`);
  }
  return trimmed;
}

function limitLines(lines: string[]): string[] {
  if (lines.length <= MAX_CACHE_LINES) return lines;
  const trimmed = lines.slice(0, MAX_CACHE_LINES);
  trimmed.push(`... (${lines.length - MAX_CACHE_LINES} more lines)`);
  return trimmed;
}

function safeSize(path?: string): number | undefined {
  if (!path) return undefined;
  try {
    return Bun.file(path).size;
  } catch {
    return undefined;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

function buildRunStatePath(stateStore: StateStore, runId: string): string {
  return `${stateStore.runsDir}/${runId}.json`;
}

export const __test = {
  formatTextPreview,
  formatJsonPreview,
  formatPlanPreview,
  formatVerifyReportPreview,
  formatLocalGatePreview,
  formatPrDraftPreview,
  formatReviewClassificationPreview,
  formatReviewFixPlanPreview,
  formatAiReviewPreview,
  formatCiFixPlanPreview,
  formatRawJsonPreview,
  groupArtifacts,
  derivePhase,
  phaseLabel,
  phaseOrder,
  artifactTitle,
  truncateOutput,
  limitLines,
  safeSize,
  formatBytes,
  buildRunStatePath,
};
