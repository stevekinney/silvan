---
description: Notes for addressing PR review feedback in this repo
paths:
  - src/cli/commands/ui.ts
  - src/core/run-review.ts
  - schemas/silvan.config.schema.json
  - package.json
---

- Avoid unused initializers in try/catch blocks; declare the callback and assign in both branches before use.
- Do not keep assignments in review-loop branches that `continue`; they never reach the final summary artifact.
- There is no `bun run check` script; use `bun run typecheck`, `bun run build`, and `bun test` when local checks are required.
- `bun run build` regenerates `schemas/silvan.config.schema.json`; only commit it when the schema change is intentional.
