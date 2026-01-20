export function readEnvValue(key: string): string | undefined {
  const bunValue = typeof Bun !== 'undefined' ? Bun.env[key] : undefined;
  if (typeof bunValue === 'string' && bunValue.length > 0) {
    return bunValue;
  }
  const processValue = process.env[key];
  return typeof processValue === 'string' && processValue.length > 0
    ? processValue
    : undefined;
}

export function setEnvValue(key: string, value: string): void {
  if (typeof Bun !== 'undefined') {
    Bun.env[key] = value;
  }
  process.env[key] = value;
}

export function unsetEnvValue(key: string): void {
  if (typeof Bun !== 'undefined') {
    delete Bun.env[key];
  }
  delete process.env[key];
}
