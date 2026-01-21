const message = [
  'Silvan runtime APIs require Bun.',
  'Use the CLI via `npx silvan` (or `bunx silvan`) for execution.',
  'For config types/utilities, import from `silvan/config` instead.',
].join(' ');

throw new Error(message);

export {};
