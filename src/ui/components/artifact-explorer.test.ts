import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import type { StateStore } from '../../state/store';
import { __test } from './artifact-explorer';

describe('artifact explorer helpers', () => {
  it('formats plan previews', () => {
    const preview = __test.formatPlanPreview({
      summary: 'Do the thing',
      steps: [{ title: 'Step 1', description: 'Work', files: ['src/a.ts'] }],
      verification: ['bun test'],
    });
    expect(preview.lines.join('\n')).toContain('Do the thing');
    expect(preview.lines.join('\n')).toContain('Step 1');
  });

  it('formats verification reports', () => {
    const preview = __test.formatVerifyReportPreview({
      ok: false,
      results: [{ name: 'lint', exitCode: 1, stderr: 'Error' }],
    });
    expect(preview.lines.join('\n')).toContain('FAIL');
    expect(preview.lines.join('\n')).toContain('lint');
  });

  it('formats local gate previews', () => {
    const preview = __test.formatLocalGatePreview({
      ok: true,
      findings: [{ severity: 'warn', title: 'Note', file: 'src/a.ts' }],
      stats: { filesChanged: 1, linesAdded: 2, linesDeleted: 3 },
    });
    expect(preview.lines.join('\n')).toContain('Files 1 | +2 | -3');
  });

  it('formats PR drafts', () => {
    const preview = __test.formatPrDraftPreview({
      title: 'PR title',
      body: 'Body text',
      checklist: ['Item'],
      testing: ['bun test'],
    });
    expect(preview.lines.join('\n')).toContain('PR title');
    expect(preview.lines.join('\n')).toContain('Checklist');
  });

  it('formats review classification and fix plans', () => {
    const classification = __test.formatReviewClassificationPreview({
      actionableThreadIds: ['t1'],
      ignoredThreadIds: [],
      needsContextThreadIds: [],
      clusters: [{ summary: 'Cluster', threadIds: ['t1'] }],
    });
    expect(classification.lines.join('\n')).toContain('Actionable: 1');

    const fixPlan = __test.formatReviewFixPlanPreview({
      threads: [{ summary: 'Fix it', actionable: true }],
      verification: ['bun test'],
    });
    expect(fixPlan.lines.join('\n')).toContain('Fix it');
  });

  it('formats AI review and CI fix plan previews', () => {
    const aiReview = __test.formatAiReviewPreview({
      shipIt: false,
      issues: [{ note: 'Issue' }],
    });
    expect(aiReview.lines.join('\n')).toContain('Ship it: No');

    const ciFix = __test.formatCiFixPlanPreview(
      { summary: 'Fix CI', steps: [{ title: 'Step' }] },
      Date.now(),
    );
    expect(ciFix.lines.join('\n')).toContain('Fix CI');
  });

  it('formats raw JSON', () => {
    const raw = __test.formatRawJsonPreview({ a: 1 });
    expect(raw.lines.join('\n')).toContain('"a": 1');
  });

  it('groups artifacts by phase and orders groups', () => {
    const grouped = __test.groupArtifacts([
      {
        id: '1',
        stepId: 'verify.run',
        name: 'report',
        kind: 'json',
        updatedAt: '2024-01-01T00:00:00Z',
        source: 'artifact',
      },
      {
        id: '2',
        stepId: 'plan.generate',
        name: 'plan',
        kind: 'json',
        updatedAt: '2024-01-02T00:00:00Z',
        source: 'artifact',
      },
    ]);
    expect(grouped[0]?.label).toBe('plan phase');
  });

  it('derives phase labels and titles', () => {
    expect(__test.phaseLabel(__test.derivePhase('review.local_gate'))).toBe(
      'review phase',
    );
    expect(
      __test.artifactTitle({
        id: 'report-1',
        stepId: 'review.local_gate',
        name: 'report',
        kind: 'json',
        updatedAt: '2024-01-01T00:00:00Z',
        source: 'artifact',
      }),
    ).toBe('report.json');
  });

  it('truncates output and limits lines', () => {
    expect(__test.truncateOutput('a\nb\nc', 2)).toEqual(['a', 'b', '... (1 more lines)']);
    const many = Array.from({ length: 200 }, (_, i) => `line-${i}`);
    const limited = __test.limitLines(many);
    expect(limited.length).toBeGreaterThan(0);
  });

  it('formats sizes and builds run state paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'silvan-artifacts-'));
    const file = join(dir, 'data.txt');
    await writeFile(file, 'hello');
    expect(__test.safeSize(file)).toBe(5);
    expect(__test.formatBytes(512)).toBe('512B');
    expect(
      __test.buildRunStatePath({ runsDir: '/tmp' } as unknown as StateStore, 'run-1'),
    ).toBe('/tmp/run-1.json');
    await rm(dir, { recursive: true, force: true });
  });
});
