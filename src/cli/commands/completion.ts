import type { CAC } from 'cac';

import {
  generateBashCompletion,
  generateFishCompletion,
  generateZshCompletion,
} from '../completion';
import { emitJsonSuccess } from '../json-output';
import type { CliOptions } from '../types';

export function registerCompletionCommand(cli: CAC): void {
  cli
    .command('completion <shell>', 'Generate shell completion script (bash, zsh, fish)')
    .action(async (shell: string, options: CliOptions) => {
      const normalized = shell.toLowerCase();
      const command = 'completion';
      const instructions: Record<string, string> = {
        bash: '# Add to ~/.bashrc: eval "$(silvan completion bash)"',
        zsh: '# Add to ~/.zshrc: eval "$(silvan completion zsh)"',
        fish: '# Save to ~/.config/fish/completions/silvan.fish',
      };

      let script: string;
      switch (normalized) {
        case 'bash':
          script = generateBashCompletion();
          break;
        case 'zsh':
          script = generateZshCompletion();
          break;
        case 'fish':
          script = generateFishCompletion();
          break;
        default:
          throw new Error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
      }

      if (options.json) {
        await emitJsonSuccess({
          command,
          data: {
            shell: normalized,
            script,
            instructions: instructions[normalized] ?? '',
          },
        });
        return;
      }

      if (options.quiet) {
        return;
      }

      console.log(script);
      const hint = instructions[normalized];
      if (hint) {
        console.log(hint);
      }
    });
}
