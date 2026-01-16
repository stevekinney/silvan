import { access, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config } from '../config/schema';
import type { RunContext } from '../core/context';
import { runGit } from '../git/exec';

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  severity: 'blocker' | 'warn' | 'info';
};

export type DoctorReport = {
  ok: boolean;
  blockers: number;
  warnings: number;
  checks: DoctorCheck[];
  context: {
    repoRoot: string;
    branch: string;
    isWorktree: boolean;
  };
  state: {
    mode: Config['state']['mode'];
    root: string;
    paths: Record<string, string>;
  };
  config: {
    source: string;
    providers: string[];
    reviewGate: {
      enabled: boolean;
      runWhen: string;
      blockPrOnFail: boolean;
    };
    models: Record<string, string | undefined>;
  };
};

type DoctorOptions = {
  network?: boolean;
};

function parseCommandBinary(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^[^\s]+/);
  return match ? match[0] : trimmed;
}

async function checkWritable(path: string): Promise<boolean> {
  try {
    const probe = join(path, `.silvan-write-${crypto.randomUUID()}`);
    await writeFile(probe, 'ok');
    await unlink(probe);
    return true;
  } catch {
    try {
      await access(path);
      return false;
    } catch {
      return false;
    }
  }
}

export async function collectDoctorReport(
  ctx: RunContext,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const repoRoot = ctx.repo.repoRoot;
  const branch = ctx.repo.branch;
  const isWorktree = Boolean(ctx.repo.worktreePath);

  const gitVersion = await runGit(['--version'], {
    cwd: repoRoot,
    bus: ctx.events.bus,
    context: { runId: ctx.runId, repoRoot, mode: ctx.events.mode },
  });
  checks.push({
    name: 'git.version',
    ok: gitVersion.exitCode === 0,
    detail: gitVersion.stdout.trim() || gitVersion.stderr.trim(),
    severity: gitVersion.exitCode === 0 ? 'info' : 'blocker',
  });

  const writablePaths: Array<[string, string]> = [
    ['runs', ctx.state.runsDir],
    ['audit', ctx.state.auditDir],
    ['artifacts', ctx.state.artifactsDir],
    ['conversations', ctx.state.conversationsDir],
    ['tasks', ctx.state.tasksDir],
  ];
  for (const [label, path] of writablePaths) {
    const ok = await checkWritable(path);
    checks.push({
      name: `state.${label}.writable`,
      ok,
      detail: ok ? 'Writable' : `Not writable: ${path}`,
      severity: ok ? 'info' : 'blocker',
    });
  }

  const configSource = ctx.configSource?.path ?? 'defaults';
  checks.push({
    name: 'config.source',
    ok: true,
    detail: configSource,
    severity: 'info',
  });

  const providers = ctx.config.task.providers.enabled;
  checks.push({
    name: 'task.providers',
    ok: providers.length > 0,
    detail: providers.join(', '),
    severity: providers.length > 0 ? 'info' : 'blocker',
  });

  if (providers.includes('github')) {
    const tokenPresent = Boolean(ctx.config.github.token);
    checks.push({
      name: 'github.token',
      ok: tokenPresent,
      detail: tokenPresent ? 'Found' : 'Missing github.token',
      severity: tokenPresent ? 'info' : 'blocker',
    });
    const ghPath = Bun.which('gh');
    checks.push({
      name: 'github.gh',
      ok: Boolean(ghPath),
      detail: ghPath ? `Found at ${ghPath}` : 'gh not found',
      severity: ghPath ? 'info' : 'warn',
    });
    if (options.network) {
      const response = await fetch('https://api.github.com/rate_limit', {
        headers: ctx.config.github.token
          ? { Authorization: `Bearer ${ctx.config.github.token}` }
          : {},
      });
      checks.push({
        name: 'github.network',
        ok: response.ok,
        detail: response.ok ? 'GitHub API reachable' : `Status ${response.status}`,
        severity: response.ok ? 'info' : 'warn',
      });
    } else {
      checks.push({
        name: 'github.network',
        ok: true,
        detail: 'Skipped (run with --network to check)',
        severity: 'info',
      });
    }
  }

  if (providers.includes('linear')) {
    const tokenPresent = Boolean(ctx.config.linear.token);
    checks.push({
      name: 'linear.token',
      ok: tokenPresent,
      detail: tokenPresent ? 'Found' : 'Missing linear.token',
      severity: tokenPresent ? 'info' : 'blocker',
    });
  }

  const verifyCommands = ctx.config.verify.commands;
  if (verifyCommands.length === 0) {
    checks.push({
      name: 'verify.commands',
      ok: false,
      detail: 'No verification commands configured',
      severity: 'warn',
    });
  } else {
    for (const command of verifyCommands) {
      const binary = parseCommandBinary(command.cmd);
      const found = Boolean(Bun.which(binary));
      checks.push({
        name: `verify.command.${command.name}`,
        ok: found,
        detail: found ? `Found ${binary}` : `Missing ${binary}`,
        severity: found ? 'info' : 'warn',
      });
    }
  }

  const blockers = checks.filter(
    (check) => !check.ok && check.severity === 'blocker',
  ).length;
  const warnings = checks.filter(
    (check) => !check.ok && check.severity === 'warn',
  ).length;

  return {
    ok: blockers === 0,
    blockers,
    warnings,
    checks,
    context: {
      repoRoot,
      branch,
      isWorktree,
    },
    state: {
      mode: ctx.config.state.mode,
      root: ctx.state.root,
      paths: {
        runs: ctx.state.runsDir,
        audit: ctx.state.auditDir,
        artifacts: ctx.state.artifactsDir,
        conversations: ctx.state.conversationsDir,
        tasks: ctx.state.tasksDir,
      },
    },
    config: {
      source: configSource,
      providers,
      reviewGate: {
        enabled: ctx.config.review.localGate.enabled,
        runWhen: ctx.config.review.localGate.runWhen,
        blockPrOnFail: ctx.config.review.localGate.blockPrOnFail,
      },
      models: {
        plan: ctx.config.ai.models.plan,
        execute: ctx.config.ai.models.execute,
        review: ctx.config.ai.models.review,
        verify: ctx.config.ai.models.verify,
        pr: ctx.config.ai.models.pr,
        recovery: ctx.config.ai.models.recovery,
      },
    },
  };
}
