import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const MAX_LINES = Number(Bun.env['SILVAN_MAX_FILE_LINES'] ?? 1200);
const ROOT = process.cwd();
const TARGET_DIR = join(ROOT, 'src');
const EXTENSIONS = new Set(['.ts', '.tsx']);
const ALLOWLIST = new Set(['src/cli/cli.ts']);

async function walk(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files);
      continue;
    }
    const ext = entry.name.slice(entry.name.lastIndexOf('.'));
    if (!EXTENSIONS.has(ext)) continue;
    files.push(full);
  }
  return files;
}

function countLines(contents: string): number {
  if (contents.length === 0) return 0;
  let count = 1;
  for (const char of contents) {
    if (char === '\n') count += 1;
  }
  return count;
}

const files = await walk(TARGET_DIR);
const violations: Array<{ path: string; lines: number }> = [];

for (const file of files) {
  const relativePath = relative(ROOT, file);
  if (ALLOWLIST.has(relativePath)) continue;
  const contents = await readFile(file, 'utf8');
  const lines = countLines(contents);
  if (lines > MAX_LINES) {
    violations.push({ path: relativePath, lines });
  }
}

if (violations.length === 0) {
  console.log(`File size check passed (max ${MAX_LINES} lines).`);
  process.exit(0);
}

violations.sort((a, b) => b.lines - a.lines);
console.error(`Files exceed ${MAX_LINES} lines:`);
for (const violation of violations) {
  console.error(`- ${violation.path} (${violation.lines})`);
}
process.exit(1);
