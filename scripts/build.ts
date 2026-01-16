import { $ } from 'bun';

const entrypoints = ['./src/index.ts', './src/config/index.ts'];

await $`rm -rf dist`;

await Bun.build({
  entrypoints,
  outdir: './dist',
  target: 'node',
  format: 'esm',
  naming: '[dir]/[name].js',
  sourcemap: 'external',
  minify: true,
  loader: {
    '.graphql': 'text',
  },
});

await $`bunx tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;
await $`bun run scripts/generate-config-schema.ts`;

console.log('Build complete!');
