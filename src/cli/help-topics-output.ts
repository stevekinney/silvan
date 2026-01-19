import type { HelpTopic } from '../help/topics';
import { groupHelpTopics } from '../help/topics';
import { DEFAULT_LINE_WIDTH, divider, padLabel, renderSectionHeader } from './output';

const LINE_WIDTH = DEFAULT_LINE_WIDTH;

export function renderHelpTopicsList(topics: HelpTopic[]): string {
  const lines: string[] = [];
  const groups = groupHelpTopics(topics);
  const labelWidth = Math.max(...topics.map((topic) => topic.id.length), 10);

  lines.push(
    renderSectionHeader('Silvan Help Topics', { width: LINE_WIDTH, kind: 'major' }),
  );
  lines.push('');

  for (const group of groups) {
    lines.push(group.category);
    lines.push(divider('minor', LINE_WIDTH));
    for (const topic of group.topics) {
      lines.push(`  ${padLabel(topic.id, labelWidth)} ${topic.summary}`);
    }
    lines.push('');
  }

  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  lines.push('');
  lines.push('Usage: silvan help <topic>');
  lines.push('For command help: silvan <command> --help');

  return lines.join('\n');
}

export function renderHelpTopic(topic: HelpTopic): string {
  const lines: string[] = [];
  lines.push(renderSectionHeader(topic.title, { width: LINE_WIDTH, kind: 'major' }));
  lines.push(...topic.intro);

  for (const section of topic.sections) {
    lines.push('');
    lines.push(renderSectionHeader(section.title, { width: LINE_WIDTH, kind: 'minor' }));
    lines.push(...section.lines);
  }

  if (topic.examples && topic.examples.length > 0) {
    lines.push('');
    lines.push(renderSectionHeader('Examples', { width: LINE_WIDTH, kind: 'minor' }));
    lines.push(...topic.examples);
  }

  if (topic.seeAlso && topic.seeAlso.length > 0) {
    lines.push('');
    lines.push(renderSectionHeader('See also', { width: LINE_WIDTH, kind: 'minor' }));
    lines.push(...topic.seeAlso.map((item) => `  ${item}`));
  }

  return lines.join('\n');
}
