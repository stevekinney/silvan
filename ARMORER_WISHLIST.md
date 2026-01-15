# Armorer Wishlist

## Desired features

- Policy hooks to allow/deny tool calls with structured reasons and centralized guardrails.
- First-class tool mutability metadata (read-only vs mutating) with enforcement helpers.
- Strongly typed tool results so outputs can flow to MCP without casting.
- Concurrency controls per tool or registry.
- Built-in execution tracing events (started/finished, duration, error).
- Zod schema ergonomics that avoid casts under exactOptionalPropertyTypes.

## What we'll do when these ship

- Replace per-tool guard logic with registry-level policy hooks.
- Swap custom read-only/mutating tracking for Armorer metadata and enforcement.
- Remove output casting in MCP adapter and rely on typed tool results.
- Throttle expensive tools (git status, verify) using Armorer concurrency limits.
- Emit standardized tool telemetry directly from Armorer hooks.
- Simplify tool definitions by passing Zod objects without shape or casts.
