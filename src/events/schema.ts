export type IsoTimestamp = string;

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';
export type EventMode = 'headless' | 'ui' | 'json';

export type EventSource =
  | 'cli'
  | 'engine'
  | 'git'
  | 'github'
  | 'linear'
  | 'ai'
  | 'verify'
  | 'ui';

export type EventEnvelope<TType extends string, TPayload> = {
  schema: 'com.silvan.events';
  version: '1.0.0';

  id: string;
  ts: IsoTimestamp;
  level: EventLevel;
  source: EventSource;

  runId: string;
  repoId: string;
  worktreeId?: string;
  prId?: string;
  ticketId?: string;

  mode?: EventMode;
  actor?: 'user' | 'system' | 'ai';
  message?: string;

  type: TType;
  payload: TPayload;

  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
    cause?: unknown;
  };

  span?: {
    spanId: string;
    parentSpanId?: string;
    startTs?: IsoTimestamp;
    endTs?: IsoTimestamp;
    durationMs?: number;
  };
};

export type Phase =
  | 'idle'
  | 'worktree'
  | 'linear'
  | 'plan'
  | 'implement'
  | 'verify'
  | 'pr'
  | 'ci'
  | 'review'
  | 'complete'
  | 'failed'
  | 'canceled';

export type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type CiState = 'pending' | 'passing' | 'failing' | 'unknown';
export type ReviewState = 'no_pr' | 'waiting' | 'has_unresolved' | 'clean';

export type RunStarted = {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  repoRoot: string;
};

export type RunPhaseChanged = {
  from: Phase;
  to: Phase;
  reason?: string;
};

export type RunStep = {
  stepId: string;
  title: string;
  status: StepStatus;
  progress?: { current?: number; total?: number; unit?: string };
};

export type RunPersisted = {
  path: string;
  snapshotId: string;
  stateVersion?: string;
};

export type RunFinished = {
  status: 'success' | 'failed' | 'canceled';
  durationMs: number;
  summary?: {
    prUrl?: string;
    commits?: string[];
    ci?: CiState;
    unresolvedReviewCount?: number;
  };
};

export type GitCommand = {
  cmd: string;
  args: string[];
  cwd: string;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
};

export type WorktreeListed = {
  count: number;
  worktrees: Array<{
    id: string;
    path: string;
    branch?: string;
    headSha?: string;
    isBare?: boolean;
    isLocked?: boolean;
    isDirty?: boolean;
  }>;
};

export type WorktreeCreated = {
  id: string;
  path: string;
  branch: string;
  baseBranch?: string;
};

export type WorktreeRemoved = {
  id: string;
  path: string;
  forced: boolean;
};

export type GitStatusSnapshot = {
  path: string;
  branch: string;
  isDirty: boolean;
  porcelain?: string;
};

export type PrIdent = { owner: string; repo: string; number: number; url?: string };

export type GitHubPrOpenedOrUpdated = {
  pr: PrIdent;
  action: 'opened' | 'updated' | 'noop';
  headBranch: string;
  baseBranch: string;
  title: string;
};

export type GitHubReviewRequested = {
  pr: PrIdent;
  reviewers: string[];
  copilotRequested: boolean;
};

export type GitHubReviewCommentsFetched = {
  pr: PrIdent;
  unresolvedCount: number;
  totalCount: number;
};

export type GitHubReviewCommentResolved = {
  pr: PrIdent;
  threadId: string;
  resolved: boolean;
  reason?: string;
};

export type GitHubPrSnapshot = {
  prs: Array<{
    id: string;
    title: string;
    url?: string;
    headBranch: string;
    baseBranch: string;
    ci: CiState;
    unresolvedReviewCount: number;
  }>;
};

export type GitHubError = {
  pr?: PrIdent;
  operation:
    | 'find_pr'
    | 'open_pr'
    | 'update_pr'
    | 'request_review'
    | 'fetch_comments'
    | 'resolve_comment'
    | 'fetch_checks';
  status?: number;
  details?: string;
};

export type CiStatus = {
  pr: PrIdent;
  state: CiState;
  summary?: string;
  checks?: Array<{
    name: string;
    state: 'queued' | 'in_progress' | 'completed';
    conclusion?:
      | 'success'
      | 'failure'
      | 'cancelled'
      | 'neutral'
      | 'skipped'
      | 'timed_out'
      | 'action_required';
    url?: string;
  }>;
};

export type CiWaitStarted = {
  pr: PrIdent;
  pollIntervalMs: number;
};

export type CiWaitFinished = {
  pr: PrIdent;
  final: CiStatus;
  durationMs: number;
};

export type AiModelInfo = {
  provider: string;
  model: string;
};

export type AiPlanGenerated = {
  model: AiModelInfo;
  planKind:
    | 'ticket_plan'
    | 'ci_fix_plan'
    | 'review_fix_plan'
    | 'recovery_plan'
    | 'pr_draft'
    | 'verification_decision';
  tokens?: { input?: number; output?: number };
  planDigest: string;
};

export type AiPlanValidated = {
  planDigest: string;
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
};

export type AiToolCall = {
  toolCallId: string;
  toolName: string;
  argsDigest: string;
};

export type AiToolCallResult = {
  toolCallId: string;
  ok: boolean;
  resultDigest?: string;
  error?: { message: string; code?: string };
};

export type AiSessionStarted = {
  model: AiModelInfo;
  allowedTools?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
};

export type AiSessionFinished = {
  model: AiModelInfo;
  ok: boolean;
  durationMs: number;
  toolCalls?: number;
};

export type AiError = {
  model: AiModelInfo;
  operation:
    | 'plan'
    | 'tool_call'
    | 'review_plan'
    | 'recover'
    | 'pr_draft'
    | 'verification_decision';
  details?: string;
};

export type Event =
  | EventEnvelope<'run.started', RunStarted>
  | EventEnvelope<'run.phase_changed', RunPhaseChanged>
  | EventEnvelope<'run.step', RunStep>
  | EventEnvelope<'run.persisted', RunPersisted>
  | EventEnvelope<'run.finished', RunFinished>
  | EventEnvelope<
      'git.command_started',
      Omit<GitCommand, 'exitCode' | 'durationMs' | 'stdout' | 'stderr'>
    >
  | EventEnvelope<'git.command_finished', GitCommand>
  | EventEnvelope<'git.status', GitStatusSnapshot>
  | EventEnvelope<'worktree.listed', WorktreeListed>
  | EventEnvelope<'worktree.created', WorktreeCreated>
  | EventEnvelope<'worktree.removed', WorktreeRemoved>
  | EventEnvelope<'github.pr_opened_or_updated', GitHubPrOpenedOrUpdated>
  | EventEnvelope<'github.prs_snapshot', GitHubPrSnapshot>
  | EventEnvelope<'github.review_requested', GitHubReviewRequested>
  | EventEnvelope<'github.review_comments_fetched', GitHubReviewCommentsFetched>
  | EventEnvelope<'github.review_thread_resolved', GitHubReviewCommentResolved>
  | EventEnvelope<'github.error', GitHubError>
  | EventEnvelope<'ci.status', CiStatus>
  | EventEnvelope<'ci.wait_started', CiWaitStarted>
  | EventEnvelope<'ci.wait_finished', CiWaitFinished>
  | EventEnvelope<'ai.plan_generated', AiPlanGenerated>
  | EventEnvelope<'ai.plan_validated', AiPlanValidated>
  | EventEnvelope<'ai.session_started', AiSessionStarted>
  | EventEnvelope<'ai.session_finished', AiSessionFinished>
  | EventEnvelope<'ai.tool_call_started', AiToolCall>
  | EventEnvelope<'ai.tool_call_finished', AiToolCallResult>
  | EventEnvelope<'ai.error', AiError>;
