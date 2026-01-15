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

- [ ] Emit ai.plan_generated/ai.plan_validated for PR drafts, review fix plans, recovery plans, and verification decisions.
- [ ] Add ai.session_started/ai.session_finished for execution runs (model + budgets + allowed tools).

## Safety and guardrails

- [ ] Enforce read-before-write (block fs.write/fs.patch on existing files unless read in session).
- [ ] Add mutation risk tiers (safe vs dangerous) with stricter flag gating.
- [ ] Harden repo path boundary checks (realpath + separator-safe prefix checks).

## Workflow completeness

- [ ] Persist verification decisions and surface next steps (don’t discard decideVerification output).
- [ ] Complete review loop (CI wait, re-request review, stop conditions for CI failure/unresolved threads).
- [ ] Apply recovery plan actions (dispatch nextAction instead of just persisting).

## DX and quality

- [ ] Add `silvan doctor` command (git/remote/config/token checks).
- [ ] Fix verification command execution to avoid `cmd.split(' ')` (support args or shell).
- [ ] Update README to reflect current agent behavior and flags.
