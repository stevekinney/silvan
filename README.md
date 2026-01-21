# Silvan

Silvan is an operator‑grade CLI for orchestrating resumable AI workflows around git repositories. It manages worktrees, plans and executes changes with guarded tools, verifies results, and drives PR/review loops with clear, deterministic gates.

Silvan is usable with or without external issue trackers. If GitHub/Linear are not configured, it still runs plan → implement → verify and stops before PR/review steps with a clear blocked reason.

## Requirements

- Git >= 2.30
- Optional: GitHub token for PR/CI automation
- Optional: Linear token for ticket intake

## Install

### npm (recommended)

```bash
npm install -g silvan
silvan --help
```

Or run without a global install:

```bash
npx silvan --help
```

The npm wrapper downloads a platform‑specific binary on first run and caches it under the Silvan cache directory.

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

- If binary download fails behind a proxy, set `SILVAN_RELEASE_BASE` to a reachable mirror URL.
- On macOS, Gatekeeper may require you to allow the binary in System Settings.

### Publishing (maintainers)

- GitHub Releases and npm publish are automated on tag pushes (`v*.*.*`) using trusted publishing (OIDC).
- Configure the npm trusted publisher for `stevekinney/silvan` and `.github/workflows/release.yaml`.
- No `NPM_TOKEN` or `NODE_AUTH_TOKEN` is required once trusted publishing is enabled.
- Release with `bun run release:patch`, `bun run release:minor`, or `bun run release:major`.
- If the package is not yet bootstrapped on npm, do one interactive publish from a maintainer machine first.

## Quick Start

```bash
# Initialize a baseline silvan.config.ts (auto-detects repo settings)
silvan init

# List worktrees
silvan tree list

# Start from a local task (no external tracker required)
silvan task start "Improve run status visibility"

# Start from a GitHub or Linear task
silvan task start GH-123
silvan task start ENG-456

# Launch the dashboard
silvan ui
```

## Help Topics

Browse conceptual help in the CLI and drill into a topic when you need detail:

```bash
silvan help
silvan help worktrees
silvan help task-refs
silvan help convergence
```

## CLI Output Conventions

Silvan output is designed to be scannable in terminals and scriptable in CI.

- Semantic colors: green success, yellow warning, red error, cyan running
- Section headers use consistent separators for fast scanning
- Commands end with a clear next steps block when there is a logical follow-on
- Non-TTY output is plain text (no ANSI colors)
- Use `--json` for machine-readable output (JSONL events with `cli.result` payloads)
- Use `--quiet` to suppress non-error output and `--verbose` for debug-level detail

## What Silvan Does Today

### Workflow overview

Default lifecycle:

1. task intake (local / GitHub / Linear)
2. plan (structured, validated)
3. implement (tool‑driven execution)
4. verify (configured commands)
5. local review gate (deterministic checks)
6. PR open + review loop (if GitHub configured)
7. converge (CI green + no unresolved review threads)

Silvan stores all artifacts and run state globally so runs can be resumed and inspected without repo‑local files.

### Local tasks (no external tracker required)

```bash
silvan task start "Add fuzzy search to run list"

# With explicit fields
silvan task start --title "Add fuzzy search" --desc "Search the run list" \
  --ac "Matches partial strings" --ac "Highlights matched text"

# From a file
silvan task start --from-file task.md
```

Pre-answer clarifications or generate a plan without creating a worktree:

```bash
silvan task start GH-42 --answer auth-method=jwt
silvan task start GH-42 --plan-only
```

If GitHub is not configured, Silvan will run plan/implement/verify and stop before PR and review steps with a clear blocked reason.

## Global State Model

Silvan stores all state outside the repo (no `.gitignore` required). Default locations:

- macOS: `~/Library/Application Support/silvan`
- Linux: `$XDG_DATA_HOME/silvan` (or `~/.local/share/silvan`)
- Windows: `%APPDATA%\silvan`

Per‑repo layout:

- `repos/<repoId>/runs` — run snapshots
- `repos/<repoId>/audit` — event audit logs (JSONL)
- `repos/<repoId>/artifacts` — run artifacts (plans, reports, summaries)
- `repos/<repoId>/conversations` — conversation snapshots
- `repos/<repoId>/tasks` — local task definitions
- `cache/repos/<repoId>` — rebuildable cache (AI results)

To keep state inside a repo, set `state.mode = "repo"` or pass `--state-mode repo`.

## Operator Control and Convergence

Silvan derives a convergence status for each run and exposes operator controls to resume, override, or abort.

Commands:

- `run status <runId>` — show convergence status and next actions
- `run explain <runId>` — show blocking reasons and relevant artifacts
- `run resume <runId>` — resume using convergence rules
- `run override <runId> <reason...>` — record an explicit operator override
- `run abort <runId> [reason]` — abort a run and mark it canceled

“Blocked” means a deterministic gate failed and requires operator intent. “Waiting” means Silvan is waiting on CI or review state.

See `docs/operator-control.md` for details.

## Local Review Gate

Before opening a PR or requesting review, Silvan runs a deterministic local gate (no model calls). It checks:

- diff size thresholds
- debug artifacts (`console.log`, `debugger`, `TODO`, `FIXME`)
- `.env` changes
- config/dependency changes
- `git diff --check`
- verification status (must pass before PR, if required)
- naming conventions

Configure under `review.localGate`:

```ts
review: {
  localGate: {
    enabled: true,
    runWhen: 'beforeReviewRequest',
    blockPrOnFail: true,
  },
}
```

Silvan can also run an optional AI reviewer after the local gate. It is enabled by
default and can be disabled via `review.aiReviewer.enabled`.

To override a blocked run, use `run override` with a reason.

## AI Architecture (precise, not magical)

Silvan separates AI work into two lanes:

- **Cognition lane** (homogenaize + conversationalist): read‑only, structured outputs for planning, classification, summaries, and recovery suggestions.
- **Execution lane** (Claude Agents SDK): tool‑using, side‑effectful execution (file edits, git ops, PR updates).

Key principles:

- Prompts are small and artifact‑first. Agents pull context via tools.
- Conversation snapshots are persisted and inspectable.
- Cognition outputs are cached by input digest to avoid repeated model calls.

Inspect conversation context:

- `convo show <runId>` — last N turns (default 20)
- `convo export <runId> --format json|md` — full snapshot

## Configuration

Silvan loads configuration via cosmiconfig (`silvan.config.*` or a `silvan` key in `package.json`).

Supported filenames:

- `silvan.config.ts`
- `silvan.config.js`
- `silvan.config.json`
- `silvan.config.yaml`
- `silvan.config.yml`

Silvan searches upward from the current working directory and treats the nearest
configuration file location as the project root for state, queue, and worktree
operations.

If no config file is found, Silvan infers defaults from the git root, existing
worktrees, optional `worktrees.toml`, and environment tokens. Run `silvan init`
to write a `silvan.config.ts` based on those detections.

Example `silvan.config.ts`:

```ts
import { defineConfig } from 'silvan/config';

export default defineConfig({
  repo: {
    defaultBranch: 'main',
  },
  task: {
    providers: {
      enabled: ['local', 'linear', 'github'],
      default: 'local',
    },
  },
  github: {
    owner: 'acme',
    repo: 'my-repo',
    reviewers: ['octocat'],
    requestCopilot: true,
  },
  verify: {
    commands: [
      { name: 'lint', cmd: 'bun run lint' },
      { name: 'test', cmd: 'bun test' },
    ],
  },
  ai: {
    cache: { enabled: true },
    cognition: {
      provider: 'anthropic',
    },
  },
  review: {
    maxIterations: 3,
  },
  state: {
    mode: 'global',
  },
  ui: {
    worktrees: {
      staleAfterDays: 7,
    },
  },
});
```

Example `silvan.config.json` with schema:

```json
{
  "$schema": "./node_modules/silvan/schemas/silvan.config.schema.json",
  "repo": { "defaultBranch": "main" }
}
```

### Configuration precedence

1. CLI flags
2. Environment variables
3. `silvan.config.*`
4. Defaults

### Environment variables

- `GITHUB_TOKEN` or `GH_TOKEN`: GitHub API access
- `LINEAR_API_KEY`: Linear task access
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`: cognition lane providers
- `SILVAN_COGNITION_DEFAULTS=1`: enable cognition-assisted defaults in `init`/`quickstart`
- `SILVAN_COGNITION_MODEL_INIT_DEFAULTS`: override the model used for init defaults
- `SILVAN_STATE_MODE=global|repo`: override state storage mode
- `SILVAN_VERIFY_PORT`: preferred port for verification commands (Silvan finds a free port when unset)
- `SILVAN_VERIFY_BASE_URL`: override base URL for verification commands
- Silvan auto-loads `.env` from the config directory or repo root and overrides existing env values.
- Verification commands receive `SILVAN_VERIFY_PORT`, `SILVAN_VERIFY_BASE_URL`, and `PORT` set to the resolved port.
- API keys are read at runtime from the environment and are never embedded in build output.

See `silvan doctor` for a full diagnostic report of effective configuration.

## Commands (high‑level)

### Worktrees

- `tree list` — list worktrees
- `tree add <name>` — create worktree + branch
- `tree remove <name>` — remove worktree (`--force` to override dirty check)
- `tree clean` — remove worktrees with merged PRs (`--all` to skip prompts)
- `tree prune | tree lock | tree unlock | tree rebase` — worktree maintenance

### Agent workflows

- `task start [task]` — create worktree + generate plan (`--answer`, `--plan-only`)
- `quickstart` — guided setup + sample plan
- `init` — scaffold a baseline `silvan.config.ts` (`--assist` for cognition defaults)
- `queue run` — process queued task requests (`--concurrency <n>`, `--continue-on-error`)
- `agent plan` — generate a structured plan
- `agent clarify` — answer required questions and re‑plan
- `agent run` — execute plan (`--dry-run`, `--apply`, `--dangerous`)
- `agent resume` — generate recovery plan and execute next action

### Runs + operator control

- `run list` / `run inspect <runId>` / `run resume <runId>`
- `run status <runId>` / `run explain <runId>` / `run override <runId> <reason...>` / `run abort <runId>`

### Diagnostics

- `doctor` — validate git, config, tokens, and verification setup (`--json`, `--network`)

### UI

- `ui` — live Ink dashboard (read‑only). Start new work via `task start`.

## Safety Guarantees

- Worktrees are never removed without confirmation unless `--yes` is passed.
- Dirty worktrees are blocked unless `--force` is provided.
- All destructive actions are gated behind `--apply` and `--dangerous`.
- Steps are idempotent; resume does not repeat destructive operations.

## Development

```bash
bun run dev
```

## Testing

```bash
bun test
```

## License

MIT
