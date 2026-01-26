import type { CAC } from 'cac';

import { SilvanError } from '../../core/errors';
import { findHelpTopic, listHelpTopics } from '../../help/topics';
import { renderHelpTopic, renderHelpTopicsList } from '../help-topics-output';
import { emitJsonSuccess } from '../json-output';
import type { CliOptions } from '../types';

export function registerHelpCommand(cli: CAC): void {
  cli
    .command('help [topic]', 'View help topics and concepts')
    .action(async (topic: string | undefined, options: CliOptions) => {
      const topics = listHelpTopics();
      const jsonMode = Boolean(options.json);

      if (!topic) {
        if (jsonMode) {
          await emitJsonSuccess({
            command: 'help',
            data: {
              topics: topics.map(({ id, title, summary, category }) => ({
                id,
                title,
                summary,
                category,
              })),
              usage: 'silvan help <topic>',
              commandHelp: 'silvan <command> --help',
            },
          });
          return;
        }

        if (options.quiet) {
          return;
        }

        console.log(renderHelpTopicsList(topics));
        return;
      }

      const matched = findHelpTopic(topic);
      if (!matched) {
        throw new SilvanError({
          code: 'help.topic_not_found',
          message: `Unknown help topic: ${topic}`,
          userMessage: `Unknown help topic: ${topic}`,
          kind: 'validation',
          nextSteps: [
            'Run `silvan help` to list available topics.',
            'Run `silvan --help` for command help.',
          ],
        });
      }

      if (jsonMode) {
        await emitJsonSuccess({
          command: 'help',
          data: {
            topic: {
              id: matched.id,
              title: matched.title,
              summary: matched.summary,
              category: matched.category,
              intro: matched.intro,
              sections: matched.sections,
              examples: matched.examples ?? [],
              seeAlso: matched.seeAlso ?? [],
            },
          },
        });
        return;
      }

      if (options.quiet) {
        return;
      }

      console.log(renderHelpTopic(matched));
    });
}
