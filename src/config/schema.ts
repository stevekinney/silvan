import { z } from 'zod';

export const verificationCommandSchema = z.object({
  name: z.string().min(1),
  cmd: z.string().min(1),
});

export const configSchema = z.object({
  repo: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      owner: z.string().optional(),
      defaultBranch: z.string().default('main'),
    })
    .default({ defaultBranch: 'main' }),
  linear: z
    .object({
      enabled: z.boolean().default(true),
      project: z.string().optional(),
      teams: z.array(z.string()).optional(),
      ticketPrefixes: z.array(z.string()).optional(),
    })
    .default({ enabled: true }),
  github: z
    .object({
      owner: z.string().optional(),
      repo: z.string().optional(),
      reviewers: z.array(z.string()).default([]),
      requestCopilot: z.boolean().default(true),
      baseBranch: z.string().optional(),
    })
    .default({ reviewers: [], requestCopilot: true }),
  verify: z
    .object({
      commands: z.array(verificationCommandSchema).default([]),
      failFast: z.boolean().default(true),
    })
    .default({ commands: [], failFast: true }),
  naming: z
    .object({
      branchPrefix: z.string().default('feature/'),
      worktreeDir: z.string().default('.worktrees'),
    })
    .default({ branchPrefix: 'feature/', worktreeDir: '.worktrees' }),
  features: z
    .object({
      autoMode: z.boolean().default(false),
      strictMode: z.boolean().default(false),
    })
    .default({ autoMode: false, strictMode: false }),
});

export type Config = z.infer<typeof configSchema>;
