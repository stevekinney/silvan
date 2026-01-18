# Copilot Instructions

Follow the repository conventions in `CLAUDE.md` and the Silvan UX standards in `skills/silvan-best-practices/references/best-practices.md`.

When touching CLI output, errors, JSON behavior, onboarding/help, or UI:

- Keep output consistent (semantic colors, standard headers, no silent success).
- Provide actionable errors and clear next steps.
- Ensure `--json` output is schema-stable and never mixed with text.
- Update tests and docs when output or schemas change.
- Keep the repo Bun-only; do not add or use Python scripts or dependencies.
