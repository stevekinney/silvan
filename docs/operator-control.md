# Operator Control and Convergence

Silvan derives a convergence status for each run. This tells you why a run is not finished and what actions are safe.

## Convergence states

- **running**: a step is in progress
- **waiting_for_user**: a deterministic gate failed (e.g., local review gate)
- **waiting_for_ci**: waiting on CI checks
- **waiting_for_review**: unresolved review threads remain
- **blocked**: a step failed and there is no automatic retry path
- **converged**: all phases completed successfully
- **failed**: run finished with failure
- **aborted**: run explicitly aborted

Silvan derives these states from run state and artifacts. They are not manually set.

## Commands

### Check status

```bash
silvan run status <runId>
```

Shows the convergence status, reason, and allowed next actions. Use `--json` for machine output.

### Explain blockers

```bash
silvan run explain <runId>
```

Shows the last successful step, blocking artifacts, and summaries (gate report, CI status, unresolved review counts).

### Resume safely

```bash
silvan run resume <runId>
```

Resumes based on convergence rules. Completed destructive steps are skipped.

### Override a gate

```bash
silvan run override <runId> "Approved despite local gate warning"
```

Records an explicit operator override. Overrides are persisted as artifacts and visible in the UI and run summaries.

### Abort a run

```bash
silvan run abort <runId> "Stopping due to scope change"
```

Marks a run as aborted and prevents further automatic actions.

## Common scenarios

### Local review gate blocked

- Status: `waiting_for_user`
- Action: inspect the local gate report, fix issues, re‑run or override with a reason

### CI failing

- Status: `waiting_for_ci` or `blocked`
- Action: inspect CI status, address failures, then resume

### Unresolved review comments

- Status: `waiting_for_review`
- Action: apply fixes and resume the review loop

## Safety guarantees

- Overrides are explicit and persisted.
- Resume does not repeat destructive actions when a step is already complete.
- Aborts are terminal.
