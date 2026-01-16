import { defineConfig } from '../../src/config/define-config';

defineConfig({
  github: {
    reviewers: [],
    requestCopilot: true,
  },
});

defineConfig({
  // @ts-expect-error extra keys should be rejected
  extra: true,
});
