import chalk from 'chalk';

import type { Event } from '../schema';

const SPINNER_FRAMES = ['-', '\\', '|', '/'];
const SPINNER_INTERVAL_MS = 80;

type StepState = {
  title: string;
  startedAtMs: number;
};

type CiWaitState = {
  startedAtMs: number;
  lastStatusKey?: string;
};

class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frameIndex = 0;
  private lineLength = 0;
  private text = '';
  private startedAtMs: number | null = null;
  private showElapsed = false;

  start(text: string, options?: { startedAtMs?: number; showElapsed?: boolean }): void {
    if (!process.stdout.isTTY) return;
    this.stop();
    this.text = text;
    this.startedAtMs = options?.startedAtMs ?? null;
    this.showElapsed = options?.showElapsed ?? false;
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
    this.startedAtMs = null;
    this.showElapsed = false;
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
    const elapsed =
      this.showElapsed && this.startedAtMs !== null
        ? ` ${formatDurationShort(Date.now() - this.startedAtMs)}`
        : '';
    const line = `${frame} ${this.text}${elapsed}`;
    process.stdout.write(`\r${line}`);
    this.lineLength = line.length;
  }
}

export class HeadlessRenderer {
  private stepStates = new Map<string, StepState>();
  private spinner = new Spinner();
  private activeStepId: string | null = null;
  private runStartedAtMs: number | null = null;
  private ciWaitStates = new Map<string, CiWaitState>();

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
        this.setRunStart(event.ts);
        this.printLine(
          chalk.dim(`Starting ${event.payload.command} in ${event.payload.repoRoot}`),
        );
        return;
      case 'run.step':
        this.renderStep(event);
        return;
      case 'ci.wait_started':
        this.renderCiWaitStarted(event);
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
        this.renderCiStatus(event);
        return;
      case 'ci.wait_finished':
        this.renderCiWaitFinished(event);
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
        const startedAtMs = this.stepStates.get(stepId)?.startedAtMs;
        this.spinner.start(lineText, {
          showElapsed: true,
          ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        });
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

  private renderCiWaitStarted(event: Extract<Event, { type: 'ci.wait_started' }>): void {
    const key = ciKey(event.payload.pr);
    this.ciWaitStates.set(key, { startedAtMs: Date.now() });
    const interval = formatDurationShort(event.payload.pollIntervalMs);
    this.printLine(`CI wait started for ${key} (poll ${interval})`);
  }

  private renderCiStatus(event: Extract<Event, { type: 'ci.status' }>): void {
    const key = ciKey(event.payload.pr);
    const checks = event.payload.checks ?? [];
    const statusKey = checks
      .map((check) => `${check.name}:${check.state}:${check.conclusion ?? ''}`)
      .join('|');
    const state = this.ciWaitStates.get(key);
    if (state?.lastStatusKey === statusKey) {
      return;
    }

    const startedAtMs = state?.startedAtMs ?? Date.now();
    this.ciWaitStates.set(key, { startedAtMs, lastStatusKey: statusKey });
    const elapsed = ` (${formatDurationShort(Date.now() - startedAtMs)})`;
    const summary = event.payload.summary ?? `${checks.length} checks`;
    this.printLine(`CI ${event.payload.state}: ${summary}${elapsed}`);

    if (checks.length > 0) {
      const isTty = Boolean(process.stdout.isTTY);
      for (const check of checks) {
        this.printLine(formatCiCheckLine(check, isTty));
      }
    }
  }

  private renderCiWaitFinished(
    event: Extract<Event, { type: 'ci.wait_finished' }>,
  ): void {
    const key = ciKey(event.payload.pr);
    this.ciWaitStates.delete(key);
    const summary = event.payload.final.summary ?? '';
    const duration = formatDurationShort(event.payload.durationMs);
    const base = summary.length > 0 ? `${summary} ` : '';
    this.printLine(`CI ${event.payload.final.state}: ${base}(total ${duration})`);
  }

  private printLine(line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    const hadSpinner = this.spinner.isActive();
    const spinnerText = this.spinner.getText();
    if (hadSpinner) {
      this.spinner.stop();
    }

    const withPrefix = process.stdout.isTTY ? line : `${this.linePrefix()}${line}`;
    if (stream === 'stderr') {
      process.stderr.write(`${withPrefix}\n`);
    } else {
      process.stdout.write(`${withPrefix}\n`);
    }

    if (hadSpinner && spinnerText) {
      this.spinner.start(spinnerText);
    }
  }

  private linePrefix(): string {
    if (!this.runStartedAtMs) {
      this.runStartedAtMs = Date.now();
    }
    const elapsedMs = Date.now() - this.runStartedAtMs;
    return `[${formatDurationClock(elapsedMs)}] `;
  }

  private setRunStart(ts: string): void {
    const parsed = Date.parse(ts);
    this.runStartedAtMs = Number.isNaN(parsed) ? Date.now() : parsed;
  }
}

function formatDuration(durationMs: number): string {
  return formatDurationShort(durationMs);
}

function formatDurationShort(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatDurationClock(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(
      seconds,
    ).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function ciKey(pr: { owner: string; repo: string; number: number }): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

function formatCiCheckLine(
  check: {
    name: string;
    state: 'queued' | 'in_progress' | 'completed';
    conclusion?:
      | 'success'
      | 'failure'
      | 'cancelled'
      | 'neutral'
      | 'skipped'
      | 'timed_out'
      | 'action_required';
  },
  isTty: boolean,
): string {
  let label = check.state === 'in_progress' ? 'running' : check.state;
  let color: ((text: string) => string) | undefined;
  let detail = '';

  if (check.state === 'queued') {
    color = isTty ? chalk.dim : undefined;
  } else if (check.state === 'in_progress') {
    color = isTty ? chalk.cyan : undefined;
  } else {
    if (check.conclusion === 'success') {
      label = 'passed';
      color = isTty ? chalk.green : undefined;
    } else if (
      check.conclusion === 'failure' ||
      check.conclusion === 'cancelled' ||
      check.conclusion === 'timed_out' ||
      check.conclusion === 'action_required'
    ) {
      label = 'failed';
      color = isTty ? chalk.red : undefined;
      detail = ` (${check.conclusion})`;
    } else if (check.conclusion) {
      label = 'completed';
      color = isTty ? chalk.yellow : undefined;
      detail = ` (${check.conclusion})`;
    } else {
      label = 'completed';
      color = isTty ? chalk.yellow : undefined;
    }
  }

  const status = color ? color(label) : label;
  return `  - ${check.name} ${status}${detail}`;
}
