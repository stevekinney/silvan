# Tasks

## Agent orchestration + tooling (Armorer + Claude Agent SDK)

- [x] Add AI event types to `src/events/schema.ts` (plan generated/validated, tool call start/finish).
- [x] Emit AI events from agent flows (plan generation, validation, tool calls).
- [x] Build Armorer registry and shared tool definitions (fs, git, github, linear, verify).
- [x] Add tool guardrails (read-only vs destructive, repo/worktree scope, confirmations, dry-run enforcement).
- [x] Implement dry-run mode for agent execution (allow safe tools only).
- [x] Add budgets/limits per phase (max tool calls, max time, max review iterations).

## Agent roles

- [x] Planner agent (ticket/worktree → plan + questions) using Claude Agent SDK, validate Plan schema, persist to run state.
- [x] Clarifier agent (questions → answers) for ambiguous tickets.
- [x] Implementation agent (plan → tool calls) with progress `run.step` events + working memory.
- [x] Verification agent (decide which commands to run, interpret failures, suggest fixes).
- [x] PR writer agent (draft PR title/body/checklist) with schema validation.
- [x] Review-response agent (threads → fix plan mapping) + auto-resolve decisions.
- [x] Recovery/resume agent (state → safest next action).

## Core orchestration

- [x] Introduce `src/core/run-controller.ts` to manage phases and state transitions.
- [x] Wire `task start`, `agent plan`, `agent run`, `agent resume` commands to the run controller.
- [x] Persist plan, clarifications, tool call logs, and review fix plans in run state.
- [x] Update dashboard reducer to surface agent phases and active steps.

## Integrations and outputs

- [x] Implement Linear ticket intake for planner (title/description/acceptance criteria).
- [x] Add PR drafting output to GitHub adapter (title/body/checklist) after verification passes.
- [x] Add review loop execution (apply fixes, re-run verification, push, resolve threads).
- [x] Add resume flow for interrupted runs with safe next-step selection.

## Observability and correctness

- [x] Correlate tool-executed events with the real run (pass EmitContext into tool registry; remove runId: 'tool' placeholders).
- [x] Track accurate phase transitions (persist/read phase in run state; emit from/to).
- [x] Standardize run.step events for run-controller operations (plan, execute, verify, PR, review, recovery).

## AI event consistency

- [x] Emit ai.plan_generated/ai.plan_validated for PR drafts, review fix plans, recovery plans, and verification decisions.
- [x] Add ai.session_started/ai.session_finished for execution runs (model + budgets + allowed tools).

## Safety and guardrails

- [x] Add mutation risk tiers (safe vs dangerous) with stricter flag gating.
- [x] Harden repo path boundary checks (realpath + separator-safe prefix checks).

## Workflow completeness

- [x] Persist verification decisions and surface next steps (don’t discard decideVerification output).
- [x] Complete review loop (CI wait, re-request review, stop conditions for CI failure/unresolved threads).
- [x] Apply recovery plan actions (dispatch nextAction instead of just persisting).

## DX and quality

- [x] Add `silvan doctor` command (git/remote/config/token checks).
- [x] Fix verification command execution to avoid `cmd.split(' ')` (support args or shell).
- [x] Update README to reflect current agent behavior and flags.

## Spec compliance punch list (recording parity)

### Dashboard parity

- [x] Repo-wide PR dashboard in Ink (list open PRs + CI state + unresolved threads).

### Linear lifecycle parity

- [x] Auto-move ticket to In Progress when execution begins (configurable state).
- [x] Move ticket to In Review on PR open (optional).
- [x] Move ticket to Done on successful completion (optional).

### Clarifications loop parity

- [x] Add `silvan agent clarify` to collect answers, persist clarifications, and re-plan.
- [x] Block execution until required questions are answered.

### PR sequencing parity

- [x] Wait for CI after PR open before requesting Copilot/human review.

### Review loop parity

- [x] Loop stop condition: CI passing AND no unresolved threads.
- [x] Wait for CI after each review iteration push and persist CI status.
- [x] If CI failing, prioritize CI fix plan before review comments.
- [x] Re-request Copilot review after each successful iteration.
- [x] Resolve review threads only after verify + CI pass.

### GitHub review semantics

- [x] Align event naming/payload for thread resolution (thread vs comment).

### Crash-resume parity

- [x] Persist canonical step cursor + step start/done/fail with inputs/outputs digests.
- [x] Add leases + heartbeat for long-running steps (CI wait, agent execution).
- [x] Add checkpoint commits after implementation + review iterations.
- [x] Add runs list/inspect/resume commands.

### Success declaration parity

- [x] Persist run.status=success and final summary at completion.

## Token efficiency punch list

### Tool-driven context retrieval

- [x] Add state read tools (plan/ticket/review) for agent use.
- [x] Remove full plan JSON from executor prompt (use plan digest + tool fetch).
- [x] Remove full comment bodies from reviewer prompt (use fingerprints/excerpts + tool fetch for full thread).

### Review context compression

- [x] Persist review fingerprints/excerpts at fetch time.
- [x] Add tool to fetch full review thread by ID on demand.
- [x] Implement two-stage review planning (classify + fetch full bodies for actionable threads).

### Verification triage without tokens

- [x] Use deterministic triage rules before invoking verifier agent.
- [x] Only call verifier agent on --apply or on unclassified failures.

### Model routing per phase

- [x] Add per-phase model env vars (plan/exec/review/pr/recovery) with defaults.
- [x] Log which model is used per phase.

### Budget governors everywhere

- [x] Apply maxTurns/maxBudget/maxThinkingTokens to planner/reviewer/pr/verifier/recovery.

### Context budgeter module

- [ ] Add context budgeter utilities for truncation + sampling.
- [ ] Emit context size metadata in run state or events.

### Skip agent calls when inputs unchanged

- [x] Add input digests and cache outputs for plan/review/PR/verify to skip re-calls.

### Programmatic PR drafting

- [ ] Add deterministic PR body template and gate AI polish behind config flag.

### Deterministic local review gates

- [x] Add deterministic checks before any local review agent call.
