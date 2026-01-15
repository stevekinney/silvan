# DECISIONS.md

This document records the key architectural and product decisions for the silvan CLI.
The goal is to make future changes intentional rather than accidental.

This tool is designed to be safe, observable, resumable, and trustworthy—especially given that it automates git operations and uses AI agents.

---

## Core philosophy

- The tool behaves like a professional developer tool, not a demo.
- AI proposes, the engine decides.
- Planning and execution are explicitly separated.
- Every side effect is observable and recoverable.
- Human trust matters more than clever automation.

---

## Implementation order

Decision: Follow the “Thin slices” ordering as the initial implementation plan.

Why:

- It delivers real value early (worktrees + PR visibility).
- It forces the event model and state store to exist before UI polish.
- It avoids prematurely coupling the AI agent to UI or GitHub details.

Implication:

- Early commits may feel “boring” but establish strong foundations.
- UI and agent sophistication come later, on top of proven primitives.

---

## Runtime and language

Decision: Use Bun + TypeScript.

Why:

- Fast startup and execution for CLI workloads.
- First-class ESM and modern TS ergonomics.
- Works well with Ink, execa, and Octokit.

Non-goals:

- Supporting legacy Node versions.
- Dual Node/Bun compatibility in v1.

---

## CLI structure

Decision: Use a classic command-based CLI with an optional TUI.

- Default mode: print-and-exit commands (wt list, task start, etc.)
- Optional mode: silvan ui launches a React Ink dashboard

Why:

- Scriptability and composability matter.
- Ink is powerful but should not own the entire UX.
- Power users expect predictable stdout and exit codes.

---

## React Ink usage

Decision: Use React Ink as a subscriber-only dashboard, not the engine.

Why:

- Ink excels at rendering live state.
- Business logic should not live in UI components.
- The same event stream must power:
  - Ink dashboard
  - headless text output
  - --json output

Scope (v1):

- Single-screen dashboard
- Read-only state visualization
- Minimal keybindings (q to quit, optional refresh)

---

## Event-driven architecture

Decision: All meaningful actions emit structured events.

Why:

- Enables live UI, logging, and resumability from one source of truth.
- Avoids ad-hoc console.log logic.
- Makes debugging and replay possible.

Rules:

- Events are versioned.
- Events are structured, not free-form text.
- Secrets and raw prompts are never emitted as events.
- Events describe what happened, not how it was rendered.

---

## State and resumability

Decision: Persist run state to disk, scoped per repository.

Why:

- Long-running AI + CI workflows will be interrupted.
- Users must be able to resume safely.
- Crash recovery must not repeat destructive actions.

Implication:

- Every phase transition is persisted.
- Review loops track iteration counts and resolved comment IDs.
- State writes are atomic and guarded by a lock.

---

## Git strategy

Decision: Use real git via process execution (execa).

Why:

- Git worktrees are not well-supported by JS git libraries.
- Developers trust git’s behavior more than abstractions.
- Using git directly respects local config and tooling.

Rules:

- Never delete or mutate worktrees without confirmation (unless --yes).
- Dirty working trees are detected and block unsafe operations.
- Git commands are logged with start/end events.

---

## GitHub integration

Decision: Use Octokit for GitHub automation.

Why:

- Stable, well-documented API.
- Required for review comments, CI status, and PR management.
- Easier to test and reason about than shelling out for everything.

Auth conventions:

- Primary: GITHUB_TOKEN
- Alias: GH_TOKEN
- Optional fallback: GitHub CLI auth (read-only convenience)

Scope (v1):

- Open/update PRs
- Request reviews (including Copilot)
- Fetch unresolved review comments
- Resolve review comments
- Poll CI status

---

## Linear integration

Decision: Integrate Linear via a thin adapter.

Why:

- Linear tickets provide strong task context.
- The integration is valuable but not core to git safety.

Scope (v1):

- Fetch ticket metadata
- Move ticket to “In Progress”
- Optionally move to “Done” on success

Auth:

- LINEAR_API_KEY

## AI provider

Decision: Start with Anthropic.

Why:

- Explicitly referenced in the initial design.
- Strong support for tool use and planning workflows.

Auth:

- ANTHROPIC_API_KEY

Design constraint:

- AI adapter must be provider-agnostic.
- OpenAI or others can be added without changing core logic.

---

## AI safety model

Decision: Enforce a strict Plan → Apply model.

Rules:

- Planning phase has no side effects.
- All AI outputs are validated with Zod schemas.
- Tool calls are logged and attributable.
- AI never executes arbitrary shell commands directly.

Why:

- Prevents “spooky action at a distance.”
- Builds user trust.
- Makes review loops deterministic and resumable.

---

## Review resolution loop

Decision: Model PR review handling as an explicit loop.

Loop conditions:

- Continue if:
  - unresolved review comments > 0 OR
  - CI status is failing
- Complete only when:
  - CI passes AND
  - no unresolved review comments remain

Why:

- Mirrors how humans actually work PRs.
- Makes agent behavior predictable.
- Enables pause/resume and iteration limits.

---

## Configuration format

Decision: Use cosmiconfig with one recommended filename.

Preferred:

- silvan.config.ts

Also supported:

- silvan.config.json
- silvan.config.yaml
- silvan section in package.json

Why:

- TS config allows real logic and typing.
- Multiple formats reduce friction for adoption.

---

## Naming

Decision:

- Package name: silvan (or scoped variant)
- Binary name: silvan
- Internal identifiers: silvan
- Folders: kebab-case

Why:

- Simple, memorable, Unix-friendly.
- Avoids collisions and casing weirdness.

---

## Testing strategy

Decision: Test engine logic independently from UI.

Rules:

- Core logic has unit tests.
- Ink UI uses snapshot + interaction tests.
- Integration tests run against temporary git repos.
- No mocking git unless unavoidable.

---

## Explicit non-goals (v1)

- Supporting Windows PowerShell quirks
- Multiple concurrent UI sessions
- Full TUI navigation system
- AI self-modifying the tool itself
- “Magic” behavior without explainability

---

## Guiding principle

If the tool surprises the user, it’s probably a bug.

Everything else flows from that.

---

If you want, next we can generate:

- a matching README.md
- a CONTRIBUTING.md that aligns with this philosophy
- a starter repo scaffold that enforces these decisions structurally
