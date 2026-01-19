import { describe, expect, it } from 'bun:test';

import { findHelpTopic, listHelpTopics } from '../help/topics';
import { renderHelpTopic, renderHelpTopicsList } from './help-topics-output';

describe('help topics output', () => {
  it('renders a topic list', () => {
    const output = renderHelpTopicsList(listHelpTopics());
    expect(output).toContain('Silvan Help Topics');
    expect(output).toContain('worktrees');
    expect(output).toContain('task-refs');
    expect(output).toContain('Usage: silvan help <topic>');
  });

  it('renders a topic detail view', () => {
    const topic = findHelpTopic('task-refs');
    expect(topic).toBeDefined();
    const output = renderHelpTopic(topic!);
    expect(output).toContain('Task References');
    expect(output).toContain('GitHub issues');
    expect(output).toContain('silvan task start gh-42');
  });
});
