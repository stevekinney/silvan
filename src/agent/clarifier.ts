import type { Clarifications, Plan } from './schemas';

export function applyClarifications(plan: Plan, clarifications: Clarifications): Plan {
  if (!plan.questions?.length) return plan;
  const answered = new Set(clarifications.answers.map((answer) => answer.id));
  const remaining = plan.questions.filter((question) => !answered.has(question.id));
  return {
    ...plan,
    ...(remaining.length > 0 ? { questions: remaining } : {}),
  };
}
