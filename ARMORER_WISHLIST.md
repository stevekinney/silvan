# Armorer Wishlist

## Prompt for the Armorer team

We’re using Armorer 0.4.0 in Silvan (a Bun + TS CLI that orchestrates Claude Agents SDK tools). This file tracks the remaining gaps we’d love to see addressed. Please review the “Current gaps” list below and let us know what’s feasible and any recommended patterns. We care most about: policy hook context injection (runId/worktree/ticket), built‑in input/output digests for audit logs, session‑level budgets, structured error taxonomy, and output schema validation surfaced in telemetry. We’re happy to provide real-world examples or patches if helpful.

## Current gaps

All wishlist items are resolved in Armorer 0.4.0 and adopted in Silvan.

## Adopted in 0.3.0

- Policy hooks for centralized guardrails.
- Tool mutability metadata (read-only vs mutating) with enforcement helpers.
- Concurrency controls per tool or registry.
- Execution tracing/telemetry hooks.
- Zod schema ergonomics without `.shape` casts under `exactOptionalPropertyTypes`.

## Notes

- Silvan is on Armorer 0.4.0 and relies on the adopted features.
