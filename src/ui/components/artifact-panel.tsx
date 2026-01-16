import { Box, Text } from 'ink';
import React from 'react';

import type { RunRecord } from '../types';
import { CiBadge, ReviewBadge, StatusBadge } from './badges';

export function ArtifactPanel({ run }: { run: RunRecord }): React.ReactElement {
  return (
    <Box flexDirection="column" gap={0}>
      <Box flexDirection="row" gap={1}>
        <StatusBadge status={run.status} />
        <Text>{run.phase}</Text>
        {run.step ? <Text color="gray">{run.step.title ?? run.step.stepId}</Text> : null}
      </Box>
      {run.taskId ? (
        <Text color="magenta">
          {run.taskKey ?? run.taskId} {run.taskTitle ? `• ${run.taskTitle}` : ''}
          {run.taskProvider ? ` • ${run.taskProvider}` : ''}
        </Text>
      ) : null}
      {run.taskId && !run.taskUrl ? <Text color="gray">No external tracker</Text> : null}
      {run.blockedReason ? (
        <Text color="yellow">Blocked: {run.blockedReason}</Text>
      ) : null}
      {run.pr ? (
        <Text color="cyan">
          {run.pr.id} {run.pr.url ? `• ${run.pr.url}` : ''}
        </Text>
      ) : (
        <Text color="gray">No PR yet</Text>
      )}
      <Box flexDirection="row" gap={1}>
        {run.ci ? <CiBadge state={run.ci.state} /> : <Text color="gray">CI ?</Text>}
        {run.review ? <ReviewBadge count={run.review.unresolvedCount} /> : null}
        {run.review?.iteration ? (
          <Text color="gray">Review #{run.review.iteration}</Text>
        ) : null}
      </Box>
      {run.checkpoints && run.checkpoints.length > 0 ? (
        <Text color="gray">Checkpoints: {run.checkpoints.join(', ')}</Text>
      ) : null}
      {run.verification ? (
        <Text color={run.verification.ok ? 'green' : 'red'}>
          Verify: {run.verification.ok ? 'passed' : 'failed'}
          {run.verification.lastRunAt ? ` • ${run.verification.lastRunAt}` : ''}
        </Text>
      ) : null}
      {run.reviewVerification ? (
        <Text color={run.reviewVerification.ok ? 'green' : 'red'}>
          Review verify: {run.reviewVerification.ok ? 'passed' : 'failed'}
          {run.reviewVerification.lastRunAt
            ? ` • ${run.reviewVerification.lastRunAt}`
            : ''}
        </Text>
      ) : null}
      {run.reviewClassification ? (
        <Text color="gray">
          Review triage: {run.reviewClassification.actionable} actionable,{' '}
          {run.reviewClassification.ignored} ignored,{' '}
          {run.reviewClassification.needsContext} needs context
        </Text>
      ) : null}
      {run.reviewFixPlan ? (
        <Text color="gray">
          Review plan: {run.reviewFixPlan.actionable} actionable,{' '}
          {run.reviewFixPlan.ignored} ignored
        </Text>
      ) : null}
      {run.verificationDecision ? (
        <Text color="gray">
          Verify next: {run.verificationDecision.commands.join(', ') || 'none'}
          {run.verificationDecision.askUser ? ' • ask user' : ''}
        </Text>
      ) : null}
      {run.recoverySummary ? (
        <Text color="yellow">
          Recovery: {run.recoverySummary.nextAction} • {run.recoverySummary.reason}
        </Text>
      ) : null}
      {run.promptSummaries && run.promptSummaries.length > 0 ? (
        <Text color="gray">Prompts: {run.promptSummaries.join(' • ')}</Text>
      ) : null}
      {run.toolCalls ? (
        <Text color="gray">
          Tool calls: {run.toolCalls.total}
          {run.toolCalls.failed ? ` • ${run.toolCalls.failed} failed` : ''}
        </Text>
      ) : null}
      {run.stuck ? <Text color="red">Stuck: {run.stuck.reason}</Text> : null}
    </Box>
  );
}
