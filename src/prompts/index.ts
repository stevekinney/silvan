import { hashString } from '../utils/hash';
import { promptSchemaByKind } from './schema';
import type { PromptEnvelope } from './types';

type PromptKind = keyof typeof promptSchemaByKind;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize(record[key]);
    }
    return result;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashInputs(inputs: unknown): string {
  return hashString(stableStringify(inputs));
}

export function hashPrompt(prompt: PromptEnvelope): string {
  const payload = {
    promptKind: prompt.promptKind,
    promptVersion: prompt.promptVersion,
    inputsDigest: prompt.inputsDigest,
    body: prompt.body,
  };
  return hashString(stableStringify(payload));
}

export function validatePrompt<K extends PromptKind>(
  kind: K,
  payload: unknown,
): PromptEnvelope {
  const schema = promptSchemaByKind[kind];
  if (!schema) {
    throw new Error(`Unsupported prompt kind: ${kind}`);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Prompt validation failed: ${parsed.error.message}`);
  }
  return parsed.data as PromptEnvelope;
}

export function renderPromptSummary(prompt: PromptEnvelope): string {
  switch (prompt.promptKind) {
    case 'execution_kickoff': {
      const body = prompt.body;
      return `Execution kickoff: ${body.objective}`;
    }
    case 'review_remediation_kickoff': {
      const body = prompt.body;
      return `Review remediation: ${body.objective}`;
    }
    default:
      return 'Prompt';
  }
}

export { promptSchemaByKind } from './schema';
export type { PromptEnvelope } from './types';
