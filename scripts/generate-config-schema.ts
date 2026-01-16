import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { toJSONSchema } from 'zod/v4';

import { configSchema } from '../src/config/schema';

const schema = toJSONSchema(configSchema, { target: 'draft-07' });

const outputs = [
  join('schemas', 'silvan.config.schema.json'),
  join('dist', 'config.schema.json'),
];

await mkdir('schemas', { recursive: true });

for (const output of outputs) {
  if (output.startsWith('dist')) {
    try {
      await mkdir('dist', { recursive: true });
    } catch {
      // ignore
    }
  }
  await Bun.write(output, JSON.stringify(schema, null, 2));
}

console.log('Config schema generated.');
