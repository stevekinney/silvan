# Silvan Product Roadmap

This document outlines the product roadmap for Silvan, an operator-grade CLI for orchestrating resumable AI workflows around git repositories. Features are organized by theme and priority, not by timeline.

## Vision

Silvan aims to be the definitive tool for teams running AI-assisted development workflows at scale. The product evolves along three axes:

1. **Operator Confidence** - Provide complete visibility into cost, performance, and outcomes so operators can trust AI workflows in production
2. **Intelligent Automation** - Move from reactive to proactive, with smarter model selection, automatic recovery, and continuous learning
3. **Team Scale** - Support multi-repo orchestration, concurrent workflows, and integrations with team communication tools

---

## Observability and Cost Control

### - [ ] Cost Tracking and Budget Enforcement

**Problem**: Operators configure token budgets per phase (`ai.budgets.plan.maxBudgetUsd`) but have no visibility into actual spend, no alerts when approaching limits, and no historical cost data for capacity planning.

**Acceptance Criteria**:

- `run status <runId>` displays cumulative cost by phase (plan, execute, review, etc.)
- `silvan costs` command shows cost breakdown by run, task, and time period
- When a phase exceeds 80% of its budget, emit a warning event
- When a phase would exceed 100% of budget, block execution with a clear error and `run override` escape hatch
- Cost data persists in run state and is queryable via `--json` output

**Product Requirements**:

- Track input/output tokens per API call with provider-specific pricing
- Support custom pricing overrides for enterprise/negotiated rates
- Cost attribution must work across all cognition tasks (13 task types)
- Budget enforcement must respect phase-level and default-level settings
- Export cost data in a format compatible with cost management tools (CSV, JSON)

**Success Metrics**:

- 100% of API calls have cost attribution
- Budget overruns blocked with actionable error message
- Operators can generate monthly cost reports

---

### - [x] Run Analytics and Success Reporting

**Problem**: There is no aggregate view of workflow success rates, common failure modes, or performance trends. Operators cannot answer "How often do runs succeed?" or "What phase fails most often?"

**Acceptance Criteria**:

- `silvan analytics` command shows success/failure rates, average duration by phase, and common failure reasons
- Filter analytics by time range, task provider, and repository
- Export analytics as JSON for dashboards
- Track and display: runs started, runs converged, runs failed, runs aborted, average time-to-convergence

**Product Requirements**:

- Analytics derived from existing JSONL audit trail (no new data collection)
- Support aggregation across multiple repositories
- Provide both summary statistics and drill-down capability
- Include phase-level breakdown (e.g., "35% of failures occur in verify phase")

**Success Metrics**:

- Operators can identify top 3 failure modes without manual log analysis
- Time-to-answer for "What's our success rate?" is under 5 seconds

---

## Intelligence and Automation

### - [x] Smart Model Routing with Recommendations

**Problem**: Silvan supports 7 phase-specific models and 13 cognition tasks with `modelByTask` overrides, but operators have no guidance on which models to use. Model selection is trial-and-error.

**Acceptance Criteria**:

- `silvan models recommend` analyzes recent runs and suggests optimal model configuration
- Recommendations based on: task complexity, cost efficiency, success rate by model
- Display estimated cost impact of recommendations
- `silvan models benchmark` runs a sample task through multiple models and compares results

**Product Requirements**:

- Recommendations consider both cost and quality (not just cheapest)
- Support A/B testing mode: route percentage of tasks to alternative models
- Track model performance metrics: latency, tokens used, success rate per task type
- Recommendations exportable as config snippet

**Success Metrics**:

- Operators can reduce cost by 20% or improve success rate by 10% following recommendations

---

### - [x] Automatic Learning Application

**Problem**: The learning system generates notes (`learning.mode: artifact`) but requires manual review to apply. Operators want high-confidence learnings applied automatically.

**Acceptance Criteria**:

- New config option `learning.autoApply.enabled` (default: true)
- Configure confidence threshold for auto-apply
- Auto-applied learnings committed with clear attribution (commit message references run)
- `silvan learning review` shows pending learnings that did not meet auto-apply threshold
- Ability to approve/reject pending learnings in batch

**Product Requirements**:

- Confidence scoring based on: consistency across multiple runs, reviewer approval, CI success
- Never auto-apply learnings that modify code (only docs, rules, skills files)
- Audit trail of all auto-applied learnings
- Rollback mechanism for problematic learnings

---

### - [x] Verification Failure Auto-Recovery

**Problem**: When verification fails, the current triage system (`verify/triage.ts`) classifies failures but does not suggest fixes. Operators must manually diagnose and retry.

**Acceptance Criteria**:

- After verification failure, generate AI-powered fix suggestions
- For common failure patterns (lint, type errors, test failures), attempt automatic fix
- Display diff preview before applying auto-fix
- `--auto-fix` flag to enable automatic recovery attempts
- Maximum auto-fix attempts configurable (default: 2)

**Product Requirements**:

- Auto-fix isolated to verification failures (not arbitrary code changes)
- Each fix attempt logged in audit trail
- Fix suggestions include confidence score
- Fallback to user intervention when auto-fix fails twice

**Success Metrics**:

- 50% of lint/type failures auto-resolved without user intervention
- Mean time to verification pass reduced by 30%

---

### - [x] Review Intelligence and Priority Triage

**Problem**: Review threads are treated equally. There is no prioritization based on severity, no suggested reviewers based on code ownership, and no automated resolution for trivial comments.

**Acceptance Criteria**:

- Classify review comments by severity: blocking, suggestion, question, nitpick
- Auto-resolve nitpicks with acknowledgment comment (configurable)
- Suggest reviewers based on git blame / CODEOWNERS
- `run explain` shows review threads sorted by priority
- Track reviewer response patterns to optimize assignment

**Product Requirements**:

- Classification model configurable via `ai.cognition.modelByTask.reviewClassify`
- Severity thresholds configurable (e.g., "block on security comments, auto-resolve style nitpicks")
- Integration with GitHub CODEOWNERS file
- Reviewer suggestions consider availability (if GitHub API provides this)

---

### - [x] Conversation Context Optimization

**Problem**: Conversation pruning exists (`ai.conversation.pruning`) but uses simple turn/byte limits. Long-running workflows accumulate context inefficiently, increasing cost and reducing coherence.

**Acceptance Criteria**:

- Implement semantic compression: summarize older turns while preserving key decisions
- Priority-based retention: keep error messages, tool results, and user corrections longer
- `convo optimize <runId>` manually triggers context optimization
- Display context efficiency metrics: compression ratio, tokens saved

**Product Requirements**:

- Compression preserves all information needed to resume from any checkpoint
- Configurable retention rules by message type (system, user, assistant, tool_result)
- Compression logged in conversation metadata
- Rollback to uncompressed state if needed

---

## Scale and Concurrency

### - [ ] Priority Queue with Load Balancing

**Problem**: The queue system (`state/queue.ts`) processes tasks FIFO without priority. Batch workloads cannot prioritize urgent tasks or balance load across resources.

**Acceptance Criteria**:

- Assign priority to queue requests (1-10, default 5)
- `queue run` processes high-priority tasks first
- Support priority escalation: tasks waiting longer than threshold get priority boost
- `queue status` shows queue depth by priority level
- Configurable concurrency limits by priority tier

**Product Requirements**:

- Priority stored in queue request JSON
- `task start --priority <n>` sets initial priority
- API for external systems to adjust priority
- Starvation prevention: ensure low-priority tasks eventually run

---

### - [ ] Cross-Repository Orchestration

**Problem**: Silvan operates on single repositories. Teams with monorepos or multi-repo architectures cannot coordinate changes across boundaries.

**Acceptance Criteria**:

- `silvan workspace init` creates a workspace configuration linking multiple repos
- `task start` can reference tasks that span repositories
- Workspace-level queue and convergence tracking
- `workspace status` shows aggregate state across all repos
- Dependency ordering: "repo B changes depend on repo A PR merging"

**Product Requirements**:

- Workspace config stored outside individual repos
- Each repo retains its own `silvan.config.ts` for repo-specific settings
- Cross-repo runs linked via workspace ID
- Support for both monorepo (single git root, multiple logical projects) and multi-repo patterns

---

### - [ ] Concurrent Run Batching

**Problem**: When multiple tasks target the same files, concurrent runs can conflict. There is no detection or coordination mechanism.

**Acceptance Criteria**:

- Detect file overlap between queued tasks before starting runs
- Option to batch overlapping tasks into a single run
- Option to serialize overlapping tasks (run sequentially)
- `queue analyze` shows potential conflicts before running
- Configurable conflict resolution strategy per repository

**Product Requirements**:

- Overlap detection based on task description analysis and historical file patterns
- Batching preserves individual task identity for tracking
- Conflict detection runs before worktree creation
- Manual override to force parallel execution

---

## Developer Experience

### - [ ] Custom Tool Extension System

**Problem**: The tool registry (`agent/registry.ts`) is hardcoded. Teams cannot add domain-specific tools without modifying Silvan source.

**Acceptance Criteria**:

- Define custom tools in `silvan.config.ts` under `tools.custom`
- Tools specify: name, description, schema (Zod), handler (file path or inline)
- Custom tools appear in agent tool list alongside built-in tools
- `silvan tools list` shows all available tools with source (built-in vs custom)
- Tools can be marked as mutating/dangerous with appropriate gating

**Product Requirements**:

- Handler can be: TypeScript file path, shell command, or HTTP endpoint
- Schema validation enforced before handler execution
- Custom tools sandboxed: cannot access Silvan internals directly
- Tool execution logged in audit trail

---

### - [ ] State Branching and Rollback

**Problem**: Operators cannot experiment with different approaches without affecting run state. There is no way to "try something" and revert if it fails.

**Acceptance Criteria**:

- `run branch <runId>` creates a named branch of run state
- Work on branch without affecting original run
- `run merge <branchName>` merges branch back (if successful)
- `run rollback <runId> --to <checkpoint>` reverts to earlier state
- List available checkpoints with `run checkpoints <runId>`

**Product Requirements**:

- Checkpoints created automatically at phase boundaries
- Branch state stored separately (does not pollute original run directory)
- Rollback preserves audit trail (marks rolled-back events)
- Git worktree state synchronized with Silvan state on rollback

---

### - [ ] Advanced Git Operations

**Problem**: Silvan handles basic git operations but lacks support for complex scenarios: rebase conflicts, cherry-picking fixes across branches, and squash strategies for clean history.

**Acceptance Criteria**:

- `--squash` flag on PR creation to squash commits before merge
- Conflict detection during rebase with AI-assisted resolution suggestions
- `run cherry-pick <runId> --to <branch>` applies specific commits to another branch
- Configurable commit message templates per repository

**Product Requirements**:

- Conflict resolution preserves both versions with clear markers
- AI suggestions for conflict resolution reviewed before applying
- Cherry-pick creates audit trail linking source and destination
- Squash preserves individual commit messages in squash commit body

---

### - [ ] Cache Warming and Invalidation

**Problem**: The AI cache (`ai/cache.ts`) uses input digest for cache keys but has no invalidation strategy. Stale cache entries persist indefinitely, and there is no way to pre-warm cache for common operations.

**Acceptance Criteria**:

- Configure cache TTL per prompt kind
- `silvan cache warm` pre-generates cache entries for common operations
- `silvan cache invalidate --older-than <duration>` removes stale entries
- `silvan cache stats` shows hit rate, size, and age distribution
- Partial cache matching: reuse results when inputs are similar (not identical)

**Product Requirements**:

- TTL configurable in `ai.cache.ttl` (per prompt kind or global default)
- Cache warming based on historical prompt patterns
- Partial matching uses embedding similarity (configurable threshold)
- Cache size limits with LRU eviction

---

## Integrations and Extensibility

### - [ ] Slack/Teams/Discord Notifications

**Problem**: Operators monitor runs through the CLI or dashboard. There is no way to receive notifications in team communication tools.

**Acceptance Criteria**:

- Configure notification webhooks in `silvan.config.ts` under `notifications`
- Supported events: run started, run blocked, run converged, run failed, budget warning
- Configurable message templates per event type
- Channel routing: send different events to different channels
- Rate limiting to prevent notification spam

**Product Requirements**:

- Native integration for Slack (incoming webhooks)
- Generic webhook support for Teams, Discord, and custom endpoints
- Messages include deep links to Silvan dashboard/CLI commands
- Test notification command to verify configuration

---

### - [ ] Monitoring System Integration

**Problem**: Silvan events are logged to JSONL but not exported to standard monitoring systems. Teams cannot correlate Silvan activity with infrastructure metrics.

**Acceptance Criteria**:

- Export events to: OpenTelemetry, Datadog, custom HTTP endpoint
- Configurable event filtering (export only specific event types)
- Span propagation: Silvan runs appear as traces in APM tools
- Metrics export: run counts, duration histograms, error rates

**Product Requirements**:

- OpenTelemetry collector endpoint configurable
- Datadog API key and site configurable
- Trace context propagated through tool calls
- Metrics follow standard naming conventions (e.g., `silvan.run.duration.seconds`)

---

### - [ ] Linear Deep Integration

**Problem**: Linear integration exists for task intake but does not sync status updates, comments, or attachments bidirectionally.

**Acceptance Criteria**:

- Update Linear issue status when run phase changes
- Post PR link and run summary as Linear comment when PR opens
- Sync Linear labels to Silvan task metadata
- Create Linear issue from Silvan when task fails (optional)

**Product Requirements**:

- Status mapping configurable via `task.linear.states`
- Comment templates customizable
- Rate limiting to respect Linear API limits
- Graceful degradation if Linear unavailable

---

### - [ ] GitHub Actions Integration

**Problem**: Silvan runs as a CLI but is not easily invoked from CI/CD pipelines. Teams cannot trigger Silvan workflows from GitHub Actions.

**Acceptance Criteria**:

- Publish official GitHub Action: `silvan-ai/silvan-action`
- Action supports: task start, queue run, run resume
- Outputs: run ID, convergence status, PR URL
- Support for caching Silvan state between workflow runs
- Matrix support: run multiple tasks in parallel

**Product Requirements**:

- Action uses pinned Silvan version (configurable)
- Secrets passed via GitHub Actions secrets mechanism
- Action outputs compatible with downstream workflow steps
- Documentation includes common workflow patterns

---

## Documentation and Onboarding

### - [ ] Interactive Onboarding Wizard

**Problem**: `silvan init` generates a config file but does not guide users through understanding their options or validating their setup.

**Acceptance Criteria**:

- `silvan setup` runs interactive wizard
- Wizard detects: git configuration, available tokens, existing CI setup
- Guided prompts for each config section with explanations
- Validates configuration at each step
- Generates example task to verify end-to-end workflow

**Product Requirements**:

- Wizard works in both TTY and non-TTY environments
- Skip sections with `--skip <section>` flag
- Resume interrupted wizard
- Export wizard choices as shareable configuration

---

### - [ ] Contextual Help System

**Problem**: `silvan help` provides static text. Users cannot get context-aware help based on their current situation (e.g., "I have a blocked run, what do I do?").

**Acceptance Criteria**:

- `silvan help --context` analyzes current state and provides relevant guidance
- When run is blocked, explain why and suggest specific commands
- When configuration is invalid, explain the issue and provide fix
- Link to relevant documentation sections

**Product Requirements**:

- Context detection based on: current directory, recent runs, config validation
- Help text includes concrete examples with actual values from user's environment
- Integrate with existing help topics (`help/topics.ts`)

---

## Non-Goals (Explicit Exclusions)

The following are explicitly out of scope for the foreseeable future:

1. **Web UI** - Silvan remains CLI-first. The Ink dashboard provides sufficient visualization.
2. **Multi-tenant SaaS** - Silvan runs locally or in CI. No hosted service planned.
3. **Non-Claude AI Providers for Execution** - The execution lane uses Claude Agents SDK. Cognition lane already supports multiple providers.
4. **Real-time Collaboration** - Silvan is designed for single-operator workflows. Team coordination happens through PRs and issue trackers.
5. **IDE Plugins** - CLI is the primary interface. IDE integration can use CLI under the hood.
