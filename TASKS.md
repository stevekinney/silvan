# Tasks

- [x] Emit `run.step` events around major operations (worktree list/create/remove, PR open/update, CI wait, review fetch) to improve timeline visibility.
- [x] Add run summary data to `run.finished` (PR URL, CI state, unresolved review count) when available.
- [x] Add audit logger failure handling (one-time warning + backoff/disable) to avoid silent audit loss.
- [x] Persist derived GitHub owner/repo into run state (include source: "origin") so resume/UX can reuse it.
- [x] Refresh CI polling target if PR head SHA changes during wait (or explicitly document fixed-SHA policy).
- [x] Store compact review comment fingerprints (path, line, body hash, outdated flag) in run state for resume without refetch.
- [x] Throttle `git status` concurrency for `wt list --includeStatus` (use `p-queue`).
- [x] Skip status checks for locked worktrees in `wt list`.
- [x] Improve base branch selection when creating worktrees (prefer `origin/<defaultBranch>` if local missing, fetch if needed).
- [ ] Trim default `silvan.config.ts` to minimal, non-redundant settings (avoid explicit `undefined`).
- [x] Decide on `--no-ui` behavior (implement or remove flag).
- [ ] Consider dependency cleanup for unused packages once first callsites exist (pino, p-queue, linear/anthropic SDKs).
