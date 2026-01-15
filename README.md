# Silvan CLI

A production-quality CLI for managing git worktrees and automating PR workflows with a resumable, observable event stream.

## Requirements

- Bun >= 1.3
- Git >= 2.30
- A GitHub token for PR automation (optional for basic worktree commands)

## Install

```bash
bun install
```

## Quick Start

```bash
# List worktrees
bun run src/index.ts wt list

# Add a worktree
bun run src/index.ts wt add my-feature

# Open or update a PR for the current branch
bun run src/index.ts pr open

# Wait for CI to finish
bun run src/index.ts ci wait

# Show unresolved review comments
bun run src/index.ts review unresolved

# Launch the dashboard
bun run src/index.ts ui
```

## Configuration

The CLI loads configuration via cosmiconfig. It looks for `silvan.config.*` in the repo root or a `silvan` key in `package.json`.

Supported filenames:

- `silvan.config.ts`
- `silvan.config.js`
- `silvan.config.json`
- `silvan.config.yaml`
- `silvan.config.yml`

Example `silvan.config.ts`:

```ts
import type { Config } from './src/config/schema';

const config: Config = {
  repo: {
    defaultBranch: 'main',
  },
  linear: {
    enabled: true,
    states: {
      inProgress: 'In Progress',
      inReview: 'In Review',
      done: 'Done',
    },
  },
  github: {
    owner: 'acme',
    repo: 'my-repo',
    reviewers: ['octocat'],
    requestCopilot: true,
  },
  naming: {
    branchPrefix: 'feature/',
    worktreeDir: '.worktrees',
  },
  verify: {
    commands: [
      { name: 'lint', cmd: 'bun run lint' },
      { name: 'test', cmd: 'bun test' },
    ],
  },
};

export default config;
```

## Environment Variables

- `GITHUB_TOKEN` or `GH_TOKEN`: GitHub API access for PR and CI commands.
- `LINEAR_API_KEY`: Linear ticket access for planning.
- `CLAUDE_MODEL`: default Claude model (fallback for all phases).
- `SILVAN_MODEL_PLAN|EXECUTE|REVIEW|PR|RECOVERY|VERIFY`: override model per phase.
- `SILVAN_MAX_TOOL_CALLS`: cap tool calls per agent execution.
- `SILVAN_MAX_TOOL_MS`: cap tool execution duration per agent execution.
- `SILVAN_MAX_TURNS` (and per-phase `SILVAN_MAX_TURNS_*`): cap agent turns.
- `SILVAN_MAX_BUDGET_USD` (and per-phase `SILVAN_MAX_BUDGET_USD_*`): budget guardrails.
- `SILVAN_MAX_THINKING_TOKENS` (and per-phase `SILVAN_MAX_THINKING_TOKENS_*`): cap thinking tokens.
- `SILVAN_PERSIST_SESSIONS=1`: reuse Claude sessions across phases in a run.

## Commands

### Worktrees

- `wt list` - list worktrees and dirty status
- `wt add <name>` - create a new worktree and branch
- `wt remove <name>` - safely remove a worktree (`--force` to override dirty check)
- `wt remove --ticket <ticket>` - remove a worktree by ticket ID
- `wt clean` - remove worktrees with merged PRs (`--all` to skip prompts)
- `wt prune` - prune stale worktree metadata
- `wt lock <name>` - lock a worktree to prevent removal
- `wt unlock <name>` - unlock a worktree
- `wt rebase` - rebase current branch onto base

### Pull Requests

- `pr open` - open or update a PR for the current branch
- `pr sync` - alias for `pr open`

### CI

- `ci wait` - poll GitHub checks for the current branch

### Reviews

- `review unresolved` - fetch unresolved review comments for the current branch PR

### UI

- `ui` - launch the live Ink dashboard

### Agent workflows

- `task start [ticket]` - create worktree + generate plan (ticket inferred from branch if omitted)
- `agent plan` - generate and persist a structured plan
- `agent clarify` - answer required plan questions and regenerate the plan
- `agent run` - execute the plan and open/update PRs
  - `--dry-run` (read-only tools only)
  - `--apply` (allow safe mutations)
  - `--dangerous` (allow dangerous mutations; requires `--apply`)
- `agent resume` - generate recovery plan and execute recommended next action

### Runs

- `runs list` - list recorded runs
- `runs inspect <runId>` - inspect a run snapshot
- `runs resume <runId>` - resume a run from state

### Diagnostics

- `doctor` - validate git, config, tokens, and verification command setup

## Output Modes

All commands support:

- `--json` for machine-readable event output
- `--no-ui` to disable UI (future use)

## State and Audit Logs

Run state and audit logs are stored in `.silvan/` at the repo root:

- `.silvan/runs/` - run snapshots
- `.silvan/audit/` - event audit logs (JSONL)

## Safety Guarantees

- Worktrees are never removed without confirmation unless `--yes` is passed.
- Dirty worktrees are blocked unless `--force` is provided.
- Git commands emit start/finish events for observability.

## Agent Workflow Notes

- Planning produces a structured plan and stops if clarifications are required.
- Execution pulls plan and ticket context via tools, keeping prompts smaller.
- Verification failures are triaged deterministically; the verifier agent runs only when needed.
- Review loop waits for CI and re-requests reviewers after fixes.
- Runs persist step cursors for resumability (`runs resume <runId>`).

## Development

```bash
bun run dev
```

## Testing

```bash
bun test
```

## Roadmap

- Two-stage review planning (fingerprints → fetch full threads on demand)
- Context budgeter + cached agent outputs by digest
- Deterministic PR drafting with optional AI polish

## License

TBD
