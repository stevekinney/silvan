export function hashString(value: string): string {
  const hash = Bun.hash(value);
  return `h${hash.toString(16)}`;
}
