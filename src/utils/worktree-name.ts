import type { Task } from '../task/types';
import { hashString } from './hash';
import { sanitizeName } from './slug';

const maxWorktreeNameLength = 64;
const suffixLength = 7;

export function buildWorktreeName(task: Task): string {
  const key = task.key ?? task.id;
  const raw = task.title ? `${key}-${task.title}` : key;
  const sanitized = sanitizeName(raw);
  const suffix = `-${hashString(task.id).slice(0, suffixLength)}`;
  const maxBaseLength = maxWorktreeNameLength - suffix.length;
  const trimmed = sanitized.slice(0, Math.max(1, maxBaseLength)).replace(/-+$/g, '');
  return `${trimmed}${suffix}`;
}
