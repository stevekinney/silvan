import chalk from 'chalk';

import type { Event } from '../schema';

const SPINNER_FRAMES = ['-', '\\', '|', '/'];
const SPINNER_INTERVAL_MS = 80;

type StepState = {
  title: string;
  startedAtMs: number;
};

class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frameIndex = 0;
  private lineLength = 0;
  private text = '';

  start(text: string): void {
    if (!process.stdout.isTTY) return;
    this.stop();
    this.text = text;
    this.render();
    this.timer = setInterval(() => this.render(), SPINNER_INTERVAL_MS);
  }

  stop(finalLine?: string): void {
    if (!process.stdout.isTTY) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (finalLine !== undefined) {
      const clear = ' '.repeat(Math.max(this.lineLength, finalLine.length));
      process.stdout.write(`\r${clear}\r${finalLine}\n`);
    } else if (this.lineLength > 0) {
      process.stdout.write(`\r${' '.repeat(this.lineLength)}\r`);
    }
    this.lineLength = 0;
    this.text = '';
  }

  isActive(): boolean {
    return Boolean(this.timer);
  }

  getText(): string {
    return this.text;
  }

  private render(): void {
    const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
    this.frameIndex += 1;
    const line = `${frame} ${this.text}`;
    process.stdout.write(`\r${line}`);
    this.lineLength = line.length;
  }
}

export class HeadlessRenderer {
  private stepStates = new Map<string, StepState>();
  private spinner = new Spinner();
  private activeStepId: string | null = null;

  render(event: Event): void {
    switch (event.type) {
      case 'log.message': {
        if (event.level === 'debug' && !process.env['SILVAN_DEBUG']) {
          return;
        }
        const message = event.message ?? event.payload.message;
        if (event.level === 'error') {
          this.printLine(chalk.red(message), 'stderr');
          return;
        }
        if (event.level === 'warn') {
          this.printLine(chalk.yellow(message), 'stderr');
          return;
        }
        this.printLine(message);
        return;
      }
      case 'run.started':
        this.printLine(
          chalk.dim(`Starting ${event.payload.command} in ${event.payload.repoRoot}`),
        );
        return;
      case 'run.step':
        this.renderStep(event);
        return;
      case 'worktree.listed':
        this.printLine(`Found ${event.payload.count} worktree(s)`);
        return;
      case 'worktree.created':
        this.printLine(
          `Created worktree ${event.payload.branch} at ${event.payload.path}`,
        );
        return;
      case 'worktree.removed':
        this.printLine(`Removed worktree at ${event.payload.path}`);
        return;
      case 'github.pr_opened_or_updated':
        this.printLine(
          `${event.payload.action} PR #${event.payload.pr.number} (${event.payload.pr.url ?? 'no url'})`,
        );
        return;
      case 'ci.status':
        this.printLine(
          `CI ${event.payload.state}: ${event.payload.summary ?? ''}`.trim(),
        );
        return;
      case 'run.finished':
        this.spinner.stop();
        this.printLine(
          chalk.dim(`Run ${event.payload.status} (${event.payload.durationMs}ms)`),
        );
        return;
      default:
        if (event.message) {
          this.printLine(event.message);
        }
    }
  }

  private renderStep(event: Extract<Event, { type: 'run.step' }>): void {
    const { stepId, title, status } = event.payload;
    if (status === 'running') {
      this.stepStates.set(stepId, { title, startedAtMs: Date.now() });
      if (this.activeStepId && this.activeStepId !== stepId) {
        this.spinner.stop();
      }
      this.activeStepId = stepId;
      const lineText = `${title}...`;
      if (process.stdout.isTTY) {
        this.spinner.start(lineText);
      } else {
        this.printLine(lineText);
      }
      return;
    }

    const state = this.stepStates.get(stepId);
    const durationMs = state ? Date.now() - state.startedAtMs : undefined;
    const durationText =
      durationMs !== undefined ? ` (${formatDuration(durationMs)})` : '';
    const suffix =
      status === 'succeeded'
        ? chalk.green(`done${durationText}`)
        : status === 'failed'
          ? chalk.red('failed')
          : status;
    const line = `${title}... ${suffix}`;

    if (this.activeStepId === stepId && this.spinner.isActive()) {
      this.spinner.stop(line);
    } else {
      this.printLine(line);
    }
    this.stepStates.delete(stepId);
    if (this.activeStepId === stepId) {
      this.activeStepId = null;
    }
  }

  private printLine(line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    const hadSpinner = this.spinner.isActive();
    const spinnerText = this.spinner.getText();
    if (hadSpinner) {
      this.spinner.stop();
    }

    if (stream === 'stderr') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }

    if (hadSpinner && spinnerText) {
      this.spinner.start(spinnerText);
    }
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}
