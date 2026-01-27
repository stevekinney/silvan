import { describe, expect, it } from 'bun:test';

import { __test } from './reviewer-suggestions';

describe('reviewer suggestions helpers', () => {
  it('parses CODEOWNERS entries', () => {
    const entries = __test.parseCodeowners(
      `
# comment
/docs/ @docs-team @alice
src/*.ts @bob
      `.trim(),
      'CODEOWNERS',
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]?.pattern).toBe('/docs/');
    expect(entries[0]?.owners).toContain('@alice');
  });

  it('matches CODEOWNERS patterns with directories', () => {
    expect(__test.matchesPattern('docs/', 'docs/readme.md')).toBe(true);
    expect(__test.matchesPattern('/src/*.ts', 'src/index.ts')).toBe(true);
    expect(__test.matchesPattern('/src/*.ts', 'lib/src/index.ts')).toBe(false);
  });

  it('scores reviewers based on sources', () => {
    const ranking = __test.scoreReviewers({
      candidates: ['alice', 'bob'],
      codeowners: new Map([
        ['alice', 2],
        ['bob', 1],
      ]),
      blame: new Map([['bob', 3]]),
    });
    expect(ranking[0]).toBe('bob');
  });

  it('infers reviewer handles from aliases and email locals', () => {
    expect(
      __test.inferReviewerHandle('bob@example.com', { 'bob@example.com': 'robert' }),
    ).toBe('robert');
    expect(__test.inferReviewerHandle('alice@example.com', {})).toBe('alice');
  });
});
