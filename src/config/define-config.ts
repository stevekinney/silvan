import type { Config, ConfigInput } from './schema';
import { configSchema } from './schema';

export type { Config, ConfigInput };

export function defineConfig<T extends ConfigInput>(config: T): T {
  return config;
}

export { configSchema };
