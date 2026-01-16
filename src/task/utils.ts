const acceptanceHeading = /^#{1,6}\s*acceptance\s*criteria\s*$/i;
const checklistPattern = /^\s*[-*]\s*\[[ xX]\]\s+(.*)$/;
const bulletPattern = /^\s*[-*]\s+(.*)$/;

export function extractChecklistItems(body: string): string[] {
  return body
    .split('\n')
    .map((line) => {
      const match = line.match(checklistPattern);
      return match?.[1]?.trim() ?? null;
    })
    .filter((item): item is string => Boolean(item));
}

export function extractAcceptanceCriteria(body: string): string[] {
  const lines = body.split('\n');
  const results: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (acceptanceHeading.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection && line.trim().startsWith('#')) {
      break;
    }
    if (!inSection) continue;
    const bullet = line.match(bulletPattern);
    if (bullet) {
      const value = bullet[1];
      if (value) {
        results.push(value.trim());
      }
    }
  }

  return results;
}

export function normalizeCriteria(criteria: string[]): string[] {
  return Array.from(
    new Set(criteria.map((item) => item.trim()).filter((item) => item.length > 0)),
  );
}
