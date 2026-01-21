import { describe, expect, it } from 'bun:test';

import { stripAnsi, truncateLines, truncateText } from './text';

describe('text utilities', () => {
  it('strips ANSI escape codes', () => {
    expect(stripAnsi('\u001b[31mError\u001b[0m')).toBe('Error');
  });

  it('truncates text with ellipsis', () => {
    expect(truncateText('Hello world', 20)).toBe('Hello world');
    expect(truncateText('Hello world', 5)).toBe('He...');
    expect(truncateText('Hello world', 3)).toBe('...');
    expect(truncateText('Hello world', 0)).toBe('');
  });

  it('truncates lines and flags truncation', () => {
    const input = ['one', 'two', 'three', 'four'].join('\n');
    const result = truncateLines(input, { maxLines: 2, maxChars: 100 });
    expect(result.lines).toEqual(['one', 'two']);
    expect(result.truncated).toBe(true);
  });

  it('truncates by character limit', () => {
    const input = 'a'.repeat(50);
    const result = truncateLines(input, { maxLines: 10, maxChars: 10 });
    expect(result.lines.join('')).toBe('a'.repeat(10));
    expect(result.truncated).toBe(true);
  });
});
