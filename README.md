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

## Distribution

### npm (recommended)

```bash
npm install -g silvan
silvan --help
```

Or run without a global install:

```bash
npx silvan --help
```

The npm wrapper downloads a platform-specific binary on first run and caches it
under the Silvan cache directory.

### Direct binary download

Download the appropriate binary from GitHub Releases and run it directly:

- macOS: `silvan-darwin-x64`, `silvan-darwin-arm64`
- Linux: `silvan-linux-x64`, `silvan-linux-arm64`
- Windows: `silvan-windows-x64.exe`

If you download a Unix binary, make it executable:

```bash
chmod +x ./silvan-<platform>
./silvan-<platform> --help
```

Supported platforms:

- macOS (x64, arm64)
- Linux (x64, arm64)
- Windows (x64)

Troubleshooting:

- If the binary download fails behind a proxy, set `SILVAN_RELEASE_BASE` to a reachable mirror URL.
- On macOS, Gatekeeper may require you to allow the binary in System Settings.

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
import { defineConfig } from 'silvan/config';

const config = defineConfig({
  repo: {
    defaultBranch: 'main',
  },
  task: {
    providers: {
      enabled: ['linear', 'github'],
      default: 'linear',
    },
    github: {
      commentOnPrOpen: true,
      closeOnSuccess: false,
      labelMapping: {
        inProgress: 'status:in-progress',
        inReview: 'status:in-review',
        done: 'status:done',
      },
    },
    linear: {
      states: {
        inProgress: 'In Progress',
        inReview: 'In Review',
        done: 'Done',
      },
    },
  },
  github: {
    owner: 'acme',
    repo: 'my-repo',
    token: 'ghp_example',
    reviewers: ['octocat'],
    requestCopilot: true,
  },
  linear: {
    token: 'lin_example',
  },
  naming: {
    branchPrefix: 'feature/',
    worktreeDir: '.worktrees',
  },
  verify: {
    shell: '/bin/zsh',
    commands: [
      { name: 'lint', cmd: 'bun run lint' },
      { name: 'test', cmd: 'bun test' },
    ],
  },
  ai: {
    models: {
      default: 'claude-sonnet-4-5-20250929',
      execute: 'claude-sonnet-4-5-20250929',
    },
    cache: {
      enabled: true,
    },
    cognition: {
      provider: 'anthropic',
      modelByTask: {
        plan: 'claude-3-5-haiku-latest',
        prDraft: 'claude-3-5-haiku-latest',
      },
    },
    conversation: {
      pruning: {
        maxTurns: 80,
        maxBytes: 200000,
        summarizeAfterTurns: 30,
        keepLastTurns: 20,
      },
    },
    budgets: {
      default: { maxTurns: 12, maxBudgetUsd: 5 },
      review: { maxTurns: 8 },
    },
    toolLimits: { maxCalls: 200, maxDurationMs: 60000 },
    sessions: { persist: false },
  },
  review: {
    maxIterations: 3,
  },
  state: {
    mode: 'global',
  },
});

export default config;
```

Example `silvan.config.json` with schema:

```json
{
  "$schema": "./node_modules/silvan/schemas/silvan.config.schema.json",
  "repo": { "defaultBranch": "main" },
  "github": { "owner": "acme", "repo": "my-repo" }
}
```

YAML schema association (VS Code `settings.json`):

```json
{
  "yaml.schemas": {
    "./node_modules/silvan/schemas/silvan.config.schema.json": "silvan.config.yaml"
  }
}
```

## Configuration Precedence

Silvan resolves settings in this order:

1. CLI flags
2. Environment variables
3. `silvan.config.*`
4. Defaults

## Environment Variables

- `GITHUB_TOKEN` or `GH_TOKEN`: GitHub API access for PR and CI commands.
- `LINEAR_API_KEY`: Linear task access for planning.
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`: cognition lane provider credentials.
- `CLAUDE_MODEL`: default Claude model (fallback for all phases).
- `SILVAN_MODEL_PLAN|EXECUTE|REVIEW|PR|RECOVERY|VERIFY`: override model per phase.
- `SILVAN_COGNITION_PROVIDER`: cognition provider (`anthropic`, `openai`, `gemini`).
- `SILVAN_COGNITION_MODEL_KICKOFF|PLAN|REVIEW|CI|VERIFY|RECOVERY|PR|CONVERSATION_SUMMARY`: cognition model overrides.
- `SILVAN_MAX_TOOL_CALLS`: cap tool calls per agent execution.
- `SILVAN_MAX_TOOL_MS`: cap tool execution duration per agent execution.
- `SILVAN_MAX_TURNS` (and per-phase `SILVAN_MAX_TURNS_*`): cap agent turns.
- `SILVAN_MAX_BUDGET_USD` (and per-phase `SILVAN_MAX_BUDGET_USD_*`): budget guardrails.
- `SILVAN_MAX_THINKING_TOKENS` (and per-phase `SILVAN_MAX_THINKING_TOKENS_*`): cap thinking tokens.
- `SILVAN_MAX_REVIEW_LOOPS`: cap review loop iterations.
- `SILVAN_PERSIST_SESSIONS=1`: reuse Claude sessions across phases in a run.
- `SILVAN_STATE_MODE=global|repo`: override state storage mode.
- `SHELL`: default shell used for verify commands when `args` are not provided.

All environment variables above can also be set in `silvan.config.*` and overridden
via CLI flags.

## AI Lanes and Conversation State

Silvan separates AI work into two lanes:

- **Agent lane (Claude Agents SDK)**: tool-using, side-effectful execution (edits, git ops).
- **Cognition lane (homogenaize + conversationalist)**: read-only, structured outputs
  for planning, summaries, and triage.

All AI calls consume **conversation snapshots** persisted per run under:

```
<APP_DATA>/silvan/repos/<repoId>/conversations/<runId>.json
```

Conversation pruning is configured under `ai.conversation.pruning`.

## Global Flags

- `--github-token <token>`
- `--linear-token <token>`
- `--model <model>`
- `--model-plan <model>`
- `--model-execute <model>`
- `--model-review <model>`
- `--model-verify <model>`
- `--model-pr <model>`
- `--model-recovery <model>`
- `--cognition-provider <provider>`
- `--cognition-model-kickoff <model>`
- `--cognition-model-plan <model>`
- `--cognition-model-review <model>`
- `--cognition-model-ci <model>`
- `--cognition-model-verify <model>`
- `--cognition-model-recovery <model>`
- `--cognition-model-pr <model>`
- `--cognition-model-conversation-summary <model>`
- `--max-turns <n>`
- `--max-turns-plan <n>`
- `--max-turns-execute <n>`
- `--max-turns-review <n>`
- `--max-turns-verify <n>`
- `--max-turns-pr <n>`
- `--max-turns-recovery <n>`
- `--max-budget-usd <n>`
- `--max-budget-usd-plan <n>`
- `--max-budget-usd-execute <n>`
- `--max-budget-usd-review <n>`
- `--max-budget-usd-verify <n>`
- `--max-budget-usd-pr <n>`
- `--max-budget-usd-recovery <n>`
- `--max-thinking-tokens <n>`
- `--max-thinking-tokens-plan <n>`
- `--max-thinking-tokens-execute <n>`
- `--max-thinking-tokens-review <n>`
- `--max-thinking-tokens-verify <n>`
- `--max-thinking-tokens-pr <n>`
- `--max-thinking-tokens-recovery <n>`
- `--max-tool-calls <n>`
- `--max-tool-ms <n>`
- `--max-review-loops <n>`
- `--persist-sessions`
- `--verify-shell <path>`
- `--state-mode <mode>`

## Commands

### Worktrees

- `wt list` - list worktrees and dirty status
- `wt add <name>` - create a new worktree and branch
- `wt remove <name>` - safely remove a worktree (`--force` to override dirty check)
- `wt remove --task <task>` - remove a worktree by task reference
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

### Conversations

- `convo show <runId>` - show the last N conversation turns (default 20)
- `convo export <runId> --format json|md` - export full conversation snapshot

### UI

- `ui` - launch the live Ink dashboard
  - Keys: j/k or arrows (move), Enter (details in narrow view), b (back), / (filter), r (refresh), ? (help), q (quit)
  - Data sources: live event stream + persisted run state (for cold starts)

### Agent workflows

- `task start [task]` - create worktree + generate plan (task inferred from branch if omitted)
- accepts: `LIN-123`, `gh-123`, or `https://github.com/org/repo/issues/123`
- `agent plan` - generate and persist a structured plan
- `agent plan --task <ref>` - generate plan for a specific task ref
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
- `run status <runId>` - show convergence status and allowed next actions
- `run explain <runId>` - explain why a run is waiting or blocked
- `run resume <runId>` - resume using convergence rules (alias with intent)
- `run override <runId> <reason...>` - record an explicit operator override
- `run abort <runId> [reason]` - abort a run and mark it canceled

### Run convergence and control

Silvan derives a convergence status from run state and artifacts. Use `run status` or
`run explain` to understand what a run is waiting for and which actions are safe
to take (resume, override, wait, abort).

### Diagnostics

- `doctor` - validate git, config, tokens, and verification command setup

## Output Modes

All commands support:

- `--json` for machine-readable event output
- `--no-ui` to disable UI (future use)

## State and Audit Logs

By default, Silvan stores state and audit logs in a global per-user directory:

- macOS: `~/Library/Application Support/silvan`
- Linux: `$XDG_DATA_HOME/silvan` (or `~/.local/share/silvan`)
- Windows: `%APPDATA%\\silvan`

Per-repo data is stored under:

- `repos/<repoId>/runs` - run snapshots
- `repos/<repoId>/audit` - event audit logs (JSONL)
- `repos/<repoId>/artifacts` - run artifacts (plans, reports, summaries)
- `repos/<repoId>/conversations` - conversation snapshots
- `repos/<repoId>/tasks` - local task definitions
- cache: `cache/repos/<repoId>` (rebuildable data)

To keep state inside a repo, set `state.mode = "repo"` or pass `--state-mode repo`.
Silvan stores state in a global per-user location by default.

## Safety Guarantees

- Worktrees are never removed without confirmation unless `--yes` is passed.
- Dirty worktrees are blocked unless `--force` is provided.
- Git commands emit start/finish events for observability.

## Agent Workflow Notes

- Planning produces a structured plan and stops if clarifications are required.
- Execution pulls plan and task context via tools, keeping prompts smaller.
- Verification failures are triaged deterministically; the verifier agent runs only when needed.
- Local review gate runs deterministic checks before PR/review steps and can block unsafe changes.
- Review loop waits for CI and re-requests reviewers after fixes.
- Cognition outputs are cached by inputs digest to avoid repeat model calls.
- Runs persist step cursors for resumability (`runs resume <runId>`).
- Artifacts are stored outside the repo and indexed in run state (`runs inspect` or `silvan ui`).

## Local Review Gate

Silvan runs a deterministic local review gate before opening a PR or requesting review
(configurable). It checks diff size, debug artifacts, whitespace issues, config/dependency
changes, and verification status without spending tokens.

Configure it under `review.localGate`:

```ts
review: {
  localGate: {
    enabled: true,
    runWhen: 'beforeReviewRequest',
    blockPrOnFail: true,
  },
}
```

## Doctor Command

Run `silvan doctor` to diagnose setup issues. It reports:

- git status/version
- state directory paths + writability
- config source and effective providers
- token presence for enabled providers
- verification command availability

Use `--json` for machine output and `--network` to test provider connectivity.

## Prompt Schemas

Silvan standardizes kickoff prompts with a shared PromptSchema:

- Prompts are versioned, schema-validated, and hashable.
- Each prompt is persisted as an artifact with a digest stored in run state.
- Prompts never include large blobs (no diffs, full files, or raw review threads).

To add a new prompt kind, define its body schema in `src/prompts/schema.ts`,
export its type in `src/prompts/types.ts`, and validate it via `validatePrompt`
before persisting the artifact.

## Local Tasks

Silvan works without any issue tracker configured. Start a run from a local task:

```bash
silvan task start "Add fuzzy search to ui"
```

Optional local task flags:

```bash
silvan task start --title "Add fuzzy search" --desc "Search the run list" \
  --ac "Matches partial strings" --ac "Highlights matched text"
```

Load a local task from a file:

```bash
silvan task start --from-file task.md
```

If GitHub is not configured, Silvan will run plan/implement/verify and stop
before PR and review steps with a clear blocked reason in the run summary.

## Development

```bash
bun run dev
```

## Testing

```bash
bun test
```

## Roadmap

- Deterministic PR drafting with optional AI polish

## License

TBD
