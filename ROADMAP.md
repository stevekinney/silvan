# Silvan UX Roadmap

A prioritized plan to transform Silvan into a best-in-class CLI for AI-driven development workflows.

## Vision

Silvan should feel like **`gh` meets `railway` meets `vercel`**: polished, predictable, and powerful. Every command should be discoverable, every output should be actionable, and every error should guide you forward.

The goal is an operator-grade tool where:

- New users succeed on their first run
- Power users work efficiently across dozens of concurrent runs
- Scripters can automate everything reliably
- No one ever stares at a silent terminal wondering what happened

## Design Principles

These principles guide all UX decisions:

1. **Progressive Disclosure** - Show essential info first, details on demand
2. **Fail Forward** - Every error tells you what to do next
3. **No Silent Operations** - Every command confirms what it did
4. **Scriptable by Default** - `--json` everywhere, consistent exit codes
5. **Keyboard-First UI** - Single-key shortcuts, vim-style navigation
6. **Semantic Colors** - Green=success, Yellow=warning, Red=error, Cyan=running
7. **Documentation as UI** - `--help` is a product, not an afterthought

## Roadmap

### Phase 1: Foundation (Unblock Day-One Experience)

These issues fix the critical first-impression problems. A new user should be able to install, configure, and run their first task without confusion.

- [x] [#6 - Redesign task start UX](https://github.com/stevekinney/silvan/issues/6)

  > **Why first**: This is the primary entry point. If `task start` is confusing, users won't get past day one. Fixes "clarifications look like errors" and silent exits.

- [x] [#14 - CLI Progress Indicators for Long Operations](https://github.com/stevekinney/silvan/issues/14)

  > **Why second**: Long-running commands with no feedback make users think the tool is broken. Spinners build trust.

- [x] [#3 - Improve silvan init with auto-detection](https://github.com/stevekinney/silvan/issues/3)

  > **Why third**: Smooth onboarding. Auto-detect repo settings so users don't have to manually configure.

- [x] [#2 - Support auto-loading .env files](https://github.com/stevekinney/silvan/issues/2)
  > **Why fourth**: Removes the most common "silent failure" gotcha. Users forget to export tokens.

### Phase 2: Polish (Make Every Interaction Delightful)

These issues transform the CLI from functional to polished. Every command feels intentional and helpful.

- [x] [#15 - Improve --help with Grouped Options and Examples](https://github.com/stevekinney/silvan/issues/15)

  > Makes the CLI self-documenting. Users can learn without leaving the terminal.

- [x] [#17 - Error Messages with Actionable Recovery Steps](https://github.com/stevekinney/silvan/issues/17)

  > Eliminates dead ends. Every error becomes a learning moment.

- [x] [#16 - Success Confirmations and Next Steps](https://github.com/stevekinney/silvan/issues/16)

  > Closes the feedback loop. Users always know what they did and what to do next.

- [x] [#23 - Command Output Consistency and Semantic Colors](https://github.com/stevekinney/silvan/issues/23)

  > Unifies the visual language. The CLI feels like one cohesive product.

- [x] [#20 - run list Visual Improvements](https://github.com/stevekinney/silvan/issues/20)
  > Makes run management scannable. Operators can quickly find what they need.

### Phase 3: Discoverability (Help Users Help Themselves)

These issues make Silvan learnable. Users can explore concepts and get help without external documentation.

- [x] [#21 - Contextual Help Topics (silvan help <topic>)](https://github.com/stevekinney/silvan/issues/21)

  > Explains concepts like "worktrees" and "convergence" inline.

- [x] [#22 - First-Run Experience and Quickstart Command](https://github.com/stevekinney/silvan/issues/22)
  > Guided introduction for new users. Try before you understand.

### Phase 4: Scripting (Enable Automation)

These issues make Silvan a reliable building block for automation and CI pipelines.

- [x] [#19 - --json Output Consistency and Schema Documentation](https://github.com/stevekinney/silvan/issues/19)

  > Makes every command scriptable. JSON everywhere, errors included.

- [x] [#18 - Add --quiet and --verbose Modes](https://github.com/stevekinney/silvan/issues/18)
  > Control output verbosity for scripts and debugging.

### Phase 5: Mission Control UI (Scale to Many Runs)

These issues transform the dashboard from a simple viewer to a full operator control panel. Build in order due to dependencies.

- [x] [#8 - UI Data Layer: pagination + audit integration](https://github.com/stevekinney/silvan/issues/8)

  > **Prerequisite for all UI work**. Enables handling 100+ runs without performance issues.

- [x] [#9 - Dashboard Overview: filtering, grouping, attention queue](https://github.com/stevekinney/silvan/issues/9)

  > Core operator use case. Find and triage runs across repos.

- [x] [#10 - Run Details: lifecycle timeline, step durations, gating clarity](https://github.com/stevekinney/silvan/issues/10)

  > Understand why runs are blocked. Diagnostic depth.

- [x] [#12 - PR/CI/Review deep panel](https://github.com/stevekinney/silvan/issues/12)

  > Reduce context-switching to GitHub. See PR status inline.

- [ ] [#11 - Artifact and Report Explorer](https://github.com/stevekinney/silvan/issues/11)

  > Deep inspection for debugging. View plans and reports without leaving UI.

- [ ] [#13 - Queue and Worktree monitor](https://github.com/stevekinney/silvan/issues/13)
  > Multi-repo workspace management. See pending tasks and worktree health.

_Note: [#7 - UI Mission Control milestone](https://github.com/stevekinney/silvan/issues/7) is the tracking epic for Phase 5._

## Ideal End State

### On First Run

```
$ silvan

  Welcome to Silvan - AI-driven development workflows

  Get started:
    silvan init          Create configuration
    silvan quickstart    Guided setup + sample task
    silvan doctor        Check environment
```

### On silvan init

```
$ silvan init

  Silvan Configuration

  Detected:
    Repository      github.com/acme/my-repo
    Default branch  main
    Package manager bun

  Task providers (space to select):
  > [x] GitHub Issues
    [ ] Linear
    [x] Local tasks

  Created silvan.config.ts

  Next steps:
    1. Set GITHUB_TOKEN for PR automation
    2. Run: silvan doctor
    3. Try:  silvan task start "Your first task"
```

### On silvan task start

```
$ silvan task start "Add dark mode toggle"

  Resolving task...                          done
  Creating worktree silvan/add-dark-mode...  done (2s)
  Installing dependencies...                 done (8s)
  Generating plan...                         done (12s)

  Plan Summary
  ─────────────────────────────────────────────────────
  Summary    Add dark mode toggle to settings page
  Steps      4 implementation steps
  Files      3 files to modify
  Risks      None identified

  Ready to implement. Next steps:
    cd .worktrees/add-dark-mode
    silvan agent run --apply
```

### On Errors

```
$ silvan task start GH-999

  Error: GitHub issue #999 not found

  Possible causes:
    - Issue doesn't exist in acme/my-repo
    - GITHUB_TOKEN lacks read access

  Try:
    silvan doctor --network   Check GitHub access
    silvan help task-refs     Learn about task references
```

### On silvan run list

```
$ silvan run list

  Runs (12 total)
  ─────────────────────────────────────────────────────────────────
  ID       Status     Phase       Task                    Updated
  ─────────────────────────────────────────────────────────────────
  abc123   ● Running  implement   Add dark mode           2 min ago
  def456   ⚠ Blocked  review      Fix login bug           1 hour ago
  ghi789   ✓ Success  complete    Update docs             3 hours ago

  Filters: silvan run list --status blocked
  Details: silvan run inspect <id>
```

### On silvan ui

```
┌──────────────────────────────────────────────────────────────────────┐
│ SILVAN DASHBOARD                            Refreshed 5s ago   q:quit │
├──────────────────────────────────────────────────────────────────────┤
│ Attention (2)         │ abc123 - Add dark mode toggle                │
│ ● def456 Blocked      │ ─────────────────────────────────────────    │
│ ● jkl012 Failed       │ Phase: implement → verify                    │
│                       │ Step:  Running lint (45s)                    │
│ Runs (12)             │                                              │
│ ● abc123 Running      │ Gate Status                                  │
│   def456 Blocked      │ ⚠ Waiting: lint check pending               │
│   ghi789 Success      │ Next: Will proceed when lint passes         │
│                       │                                              │
│ Worktrees (4)         │ Artifacts                                    │
│   add-dark-mode ●     │   plan.json                                  │
│   fix-login           │   verify-report.json                         │
└──────────────────────────────────────────────────────────────────────┘
```

## Progress Tracking

| Phase              | Issues                     | Status            |
| ------------------ | -------------------------- | ----------------- |
| Foundation         | #6, #14, #3, #2            | Complete (4/4)    |
| Polish             | #15, #17, #16, #23, #20    | Complete (5/5)    |
| Discoverability    | #21, #22                   | Complete (2/2)    |
| Scripting          | #19, #18                   | Complete (2/2)    |
| Mission Control UI | #8, #9, #10, #12, #11, #13 | In progress (4/6) |

**Total: 19 issues** (excludes #7 which is a tracking epic)
