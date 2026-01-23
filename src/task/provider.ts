import type { Config } from '../config/schema';
import { SilvanError } from '../core/errors';
import type { TaskProvider } from './types';

const providerLabels: Record<TaskProvider, string> = {
  github: 'GitHub',
  linear: 'Linear',
  local: 'Local',
};

export function isTaskProviderEnabled(config: Config, provider: TaskProvider): boolean {
  return config.task.providers.enabled.includes(provider);
}

export function requireTaskProviderEnabled(config: Config, provider: TaskProvider): void {
  if (isTaskProviderEnabled(config, provider)) return;
  const label = providerLabels[provider] ?? provider;
  throw new SilvanError({
    code: 'task.provider_disabled',
    message: `${label} provider is disabled in config.`,
    userMessage: `${label} task provider is disabled.`,
    kind: 'expected',
    nextSteps: [`Enable ${label} in silvan.config.ts task.providers.enabled.`],
  });
}
