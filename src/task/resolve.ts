import type { Config } from '../config/schema';
import { requireGitHubConfig } from '../config/validate';
import type { EventBus } from '../events/bus';
import type { EmitContext } from '../events/emit';
import { sanitizeName } from '../utils/slug';
import { extractLinearTaskFromBranch } from '../utils/task-ref';
import { fetchGitHubTask, parseGitHubIssueUrl } from './providers/github';
import { fetchLinearTask } from './providers/linear';
import type { Task, TaskRef } from './types';

const linearPattern = /\b([A-Z]{2,10})-(\d+)\b/;
const githubPattern = /^gh-(\d+)$/i;

export async function resolveTask(
  taskRef: string,
  options: {
    config: Config;
    repoRoot: string;
    bus?: EventBus;
    context?: EmitContext;
  },
): Promise<{ task: Task; ref: TaskRef }> {
  const ref = parseTaskRef(taskRef, options.config);
  if (ref.provider === 'linear') {
    if (!options.config.task.providers.enabled.includes('linear')) {
      throw new Error('Linear provider is disabled in config.');
    }
    const task = await fetchLinearTask(ref.id, options.config.linear.token);
    return { task, ref };
  }

  if (!options.config.task.providers.enabled.includes('github')) {
    throw new Error('GitHub provider is disabled in config.');
  }
  const github = await requireGitHubConfig({
    config: options.config,
    repoRoot: options.repoRoot,
    ...(options.bus ? { bus: options.bus } : {}),
    context: options.context ?? { runId: 'task', repoRoot: options.repoRoot },
  });
  const owner = ref.owner ?? github.owner;
  const repo = ref.repo ?? github.repo;
  const number = ref.number ?? Number(ref.id.replace(/^gh-/i, ''));
  if (!owner || !repo || !Number.isFinite(number)) {
    throw new Error('GitHub issue reference requires owner/repo and issue number.');
  }
  const task = await fetchGitHubTask(
    { owner, repo, number },
    options.config.github.token,
  );
  return { task, ref };
}

export function parseTaskRef(input: string, config: Config): TaskRef {
  const trimmed = input.trim();
  const urlMatch = parseGitHubIssueUrl(trimmed);
  if (urlMatch) {
    return {
      provider: 'github',
      id: `gh-${urlMatch.number}`,
      raw: trimmed,
      owner: urlMatch.owner,
      repo: urlMatch.repo,
      number: urlMatch.number,
    };
  }

  const ghMatch = trimmed.match(githubPattern);
  if (ghMatch) {
    const number = Number(ghMatch[1]);
    return {
      provider: 'github',
      id: `gh-${number}`,
      raw: trimmed,
      number,
    };
  }

  const linearMatch = trimmed.match(linearPattern);
  if (linearMatch) {
    return {
      provider: 'linear',
      id: `${linearMatch[1]}-${linearMatch[2]}`,
      raw: trimmed,
    };
  }

  const defaultProvider = config.task.providers.default;
  if (!config.task.providers.enabled.includes(defaultProvider)) {
    throw new Error(`Default provider ${defaultProvider} is not enabled in config.`);
  }
  if (defaultProvider === 'github') {
    const number = Number(trimmed.replace(/^#/, ''));
    if (!Number.isFinite(number)) {
      throw new Error('GitHub task reference must be gh-<number> or an issue URL.');
    }
    return {
      provider: 'github',
      id: `gh-${number}`,
      raw: trimmed,
      number,
    };
  }

  return {
    provider: 'linear',
    id: sanitizeName(trimmed).toUpperCase(),
    raw: trimmed,
  };
}

export function inferTaskRefFromBranch(branch: string): string | null {
  const ghMatch = branch.match(/\bgh-(\d+)\b/i);
  if (ghMatch) {
    return `gh-${ghMatch[1]}`;
  }
  const linear = extractLinearTaskFromBranch(branch);
  if (linear) return linear.taskId;
  return null;
}
