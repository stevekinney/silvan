export function parseAnswerPairs(
  raw: string | string[] | undefined,
): Record<string, string> {
  const input = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const answers: Record<string, string> = {};
  for (const entry of input) {
    const [id, ...rest] = entry.split('=');
    if (!id) continue;
    const value = rest.join('=');
    if (!value) continue;
    answers[id.trim()] = value.trim();
  }
  return answers;
}
