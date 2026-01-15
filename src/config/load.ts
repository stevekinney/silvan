import { pathToFileURL } from 'node:url';

import { cosmiconfig } from 'cosmiconfig';

import type { Config } from './schema';
import { configSchema } from './schema';

export type ConfigResult = {
  config: Config;
  source: { path: string; format: string } | null;
};

async function loadTsConfig(path: string): Promise<unknown> {
  const module = (await import(pathToFileURL(path).toString())) as {
    default?: unknown;
    config?: unknown;
  };
  return module.default ?? module.config ?? module;
}

export async function loadConfig(): Promise<ConfigResult> {
  const explorer = cosmiconfig('silvan', {
    searchPlaces: [
      'silvan.config.ts',
      'silvan.config.js',
      'silvan.config.json',
      'silvan.config.yaml',
      'silvan.config.yml',
      'package.json',
    ],
    loaders: {
      '.ts': loadTsConfig,
    },
  });

  const result = await explorer.search();

  if (!result) {
    return { config: configSchema.parse({}), source: null };
  }

  const parsed = configSchema.safeParse(result.config ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid config:\n${message}`);
  }

  return {
    config: parsed.data,
    source: { path: result.filepath, format: result.isEmpty ? 'empty' : 'file' },
  };
}
