# Simplicity Review

Scope: quick pass over core modules, CLI, AI/agent pipeline, config, queue, and UI.
Primary goal: reduce cognitive load and make local reasoning possible without chasing indirection.

## Simplicity critique (where complexity is creeping in)

1. Monolithic, multi-responsibility files

- `src/cli/cli.ts` (~5.5k lines) mixes command registration, output formatting, validation, and business logic.
- `src/core/run-controller.ts` (~3.4k lines) orchestrates everything from AI calls to GitHub, verification, learning, and task lifecycle in one file.
- `src/ui/dashboard.tsx` (~900 lines) blends rendering, state wiring, keyboard shortcuts, and layout.
  Risk: any change forces wide-context reading; small edits can introduce subtle regressions.

2. Orchestration + business logic + IO are tangled

- `src/core/run-controller.ts` calls AI, GitHub, verification, state storage, and event emission directly in the same control flow.
  Risk: hard to test; unclear boundaries; error handling logic is duplicated across phases.

3. Tooling stack layers add indirection without clear payoff

- The chain `executor -> registry -> claude-adapter -> sdk` adds multiple wrappers before a tool runs.
- The same policy decisions are encoded in multiple places (registry permissions, tool gate, session options).
  Risk: debugging why a tool is/was allowed is a multi-file trace.

4. Config sprawl and duplicated policy checks

- Provider enablement is validated in `config`, `task/resolve`, and lifecycle operations.
- Multiple sources of defaults (schema, init, load, CLI flags) require careful reconciliation.
  Risk: inconsistent behavior when a new provider or option is added; extra tests for each path.

5. Wide types and “option soup” encourage defensive branching

- Many functions accept large option objects with optional fields (e.g. executor inputs, run controller options).
- The code frequently rechecks and re-spreads optionals for the same decision.
  Risk: fragile control flow; feature flags drift into permanent complexity.

6. Data shaping is duplicated between layers

- Queue priority and status are recomputed in multiple contexts (CLI, UI, loader).
- Similar “summary” objects are built in multiple places with minor variations.
  Risk: inconsistent output and higher maintenance when a field changes.

7. Event emission is deeply interleaved

- Core logic emits events at many points, often with custom payload shapes per call site.
  Risk: event schema is hard to reason about; changes require sweeping updates.

## Concrete simplifications (delete/inline/collapse)

1. Split the run controller into a small set of phase modules

- Keep a single `run-controller.ts` entrypoint.
- Extract only a few cohesive helpers: `run-plan`, `run-execute`, `run-review`, `run-verify`.
- Each helper should accept a minimal context and return a plain result, not emit events directly.

2. Flatten tool registration and permission policy

- Keep `createToolRegistry`, but move the tools list into a plain array of `{name, schema, execute}`.
- Centralize allow/deny decisions in one function; remove duplicate gates unless they provide distinct guarantees.

3. Centralize provider enablement logic

- One small helper in `task/resolve.ts` (or `config/validate.ts`) to check enabled providers.
- Remove repeated inline checks across lifecycle files; call the helper instead.

4. Reduce CLI command complexity by grouping commands

- Create a small `src/cli/commands/` folder with ~6 modules: `task`, `queue`, `review`, `config`, `doctor`, `ui`.
- Keep formatting helpers in `src/cli/output/` to avoid re-defining output logic in every command.

5. Introduce a single “queue request view” builder

- One function that takes a `QueueRequest` + config and returns the full view model.
- Reuse it for CLI/UI so priority and tier are computed once.

6. Collapse option objects where possible

- For hot paths, use named parameters or a smaller `Context` object with explicit fields.
- Avoid passing `options` that are immediately reshaped into another object.

## Recommended minimal design

- Core entrypoints stay few and explicit: `run-controller.ts`, `cli.ts`, `ui/dashboard.tsx`.
- Extract minimal, phase-focused helpers (no new frameworks): `run-plan.ts`, `run-execute.ts`, `run-review.ts`, `run-verify.ts`.
- One canonical config normalization path (`load` -> `normalize` -> `validate`), reused everywhere.
- One canonical queue view model builder reused by CLI/UI.
- Tool permission policy in one place; the registry just defines tools.

## Maintainability rubric (what “clean” looks like here)

- Local reasoning: a change to a phase touches at most two files.
- File size: avoid files > 800 lines; exceptions must be justified.
- Explicit data flow: phase helpers return plain data, no side effects except at boundaries.
- Config rules: single source of truth for defaults and provider enablement.
- Events: standardized event payload builders; no ad-hoc payloads in core logic.
- Minimal options: prefer explicit parameters over large option bags.

## Checklist: concrete actions to simplify and maintain

- [x] Split `src/core/run-controller.ts` into `run-plan.ts`, `run-execute.ts`, `run-review.ts`, `run-verify.ts` with a thin orchestrator.
- [ ] Move tool definitions in `src/agent/registry.ts` to a single array and keep policy checks in one function.
- [ ] Create a single `isProviderEnabled(config, provider)` helper and use it across `task/resolve` and lifecycle.
- [ ] Group CLI commands into `src/cli/commands/*` and keep shared formatting in `src/cli/output/*`.
- [ ] Create `buildQueueRequestView(request, config, nowMs)` and reuse in CLI + UI.
- [ ] Replace large option bags in `executePlan` and run-controller with smaller explicit parameters.
- [ ] Add a file-size guard (lint rule or CI script) to flag new files > 800 lines.
- [ ] Standardize event payload builders for core phases to reduce ad-hoc event shapes.
- [ ] Delete or inline any helper used only once after the refactor.
