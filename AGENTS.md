# AGENTS.md

These instructions apply to Codex working in this repository.

## Required guidance

- Load and follow the `silvan-best-practices` skill (`skills/silvan-best-practices`).
- Use `skills/silvan-best-practices/references/best-practices.md` as the UX standard for CLI output, errors, JSON behavior, onboarding, and UI.
- Load and follow the `npm-publishing` skill (`skills/npm-publishing`) for npm auth, trusted publishing, and release automation work.

## Repo conventions

- Use Bun for scripts and tooling (`bun run ...`).
- Keep the repo Bun-only; do not add or use Python scripts or dependencies.
- Do not use Python for automation or skill packaging; use Bun/TypeScript or shell tools.
- Reuse shared utilities; avoid one-off output formatting.
- Update tests and docs when output, schemas, or UX behavior changes.

## Simplicity learnings

- Keep core run phases in separate modules with `src/core/run-controller.ts` as the orchestrator.
- Use `src/core/run-events.ts` for run event payloads; no ad-hoc envelopes.
- Keep CLI commands in `src/cli/commands/*` with shared helpers in `src/cli/`.
- Reuse `src/queue/view.ts` for queue request presentation.
- Prefer smaller, explicit option shapes over large option bags.
- Respect the file size guard (`scripts/check-file-size.ts`), or raise the limit intentionally via `SILVAN_MAX_FILE_LINES`.

## Skill handling note

- If `skills/silvan-best-practices` is missing, call it out and continue with best effort.
