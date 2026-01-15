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
