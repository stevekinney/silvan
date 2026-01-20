import { $ } from 'bun';

const entrypoints = ['./src/index.ts', './src/config/index.ts'];

const secretKeys = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'LINEAR_API_KEY',
];

const secretSnapshot = new Map<string, string | undefined>();
for (const key of secretKeys) {
  secretSnapshot.set(key, process.env[key]);
  delete process.env[key];
  if (typeof Bun !== 'undefined') {
    delete Bun.env[key];
  }
}

try {
  await $`rm -rf dist`;

  await Bun.build({
    entrypoints,
    outdir: './dist',
    target: 'node',
    format: 'esm',
    naming: '[dir]/[name].js',
    sourcemap: 'external',
    minify: true,
    external: ['react-devtools-core'],
    loader: {
      '.graphql': 'text',
    },
  });

  await $`bunx tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;
  await $`bun run scripts/generate-config-schema.ts`;

  console.log('Build complete!');
} finally {
  for (const key of secretKeys) {
    const value = secretSnapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
      if (typeof Bun !== 'undefined') {
        delete Bun.env[key];
      }
    } else {
      process.env[key] = value;
      if (typeof Bun !== 'undefined') {
        Bun.env[key] = value;
      }
    }
  }
}
