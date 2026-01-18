# AGENTS.md

These instructions apply to Codex working in this repository.

## Required guidance

- Load and follow the `silvan-best-practices` skill (`skills/silvan-best-practices`).
- Use `skills/silvan-best-practices/references/best-practices.md` as the UX standard for CLI output, errors, JSON behavior, onboarding, and UI.

## Repo conventions

- Use Bun for scripts and tooling (`bun run ...`).
- Keep the repo Bun-only; do not add or use Python scripts or dependencies.
- Reuse shared utilities; avoid one-off output formatting.
- Update tests and docs when output, schemas, or UX behavior changes.
