import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_SKILL_NAME_LENGTH = 64;
const ALLOWED_KEYS = new Set([
  'name',
  'description',
  'license',
  'allowed-tools',
  'metadata',
]);

type ValidationResult = {
  valid: boolean;
  message: string;
};

function usage(): void {
  console.error(
    'Usage: bun run scripts/package-skill.ts <path/to/skill-folder> [output-directory]',
  );
  console.error('');
  console.error('Example:');
  console.error('  bun run scripts/package-skill.ts skills/silvan-best-practices');
  console.error(
    '  bun run scripts/package-skill.ts skills/silvan-best-practices skills/dist',
  );
}

function parseFrontmatter(content: string): { block: string } | { error: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { error: 'No YAML frontmatter found' };
  }
  return { block: match[1] ?? '' };
}

function extractTopLevelKeys(block: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const key = match[1];
    if (!key) continue;
    entries.set(key, (match[2] ?? '').trim());
  }
  return entries;
}

function validateName(name: string): string | null {
  if (!name) return null;
  if (!/^[a-z0-9-]+$/.test(name)) {
    return `Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)`;
  }
  if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
    return `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`;
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return `Name is too long (${name.length} characters). Maximum is ${MAX_SKILL_NAME_LENGTH} characters.`;
  }
  return null;
}

function validateDescription(description: string): string | null {
  if (!description) return null;
  if (description.includes('<') || description.includes('>')) {
    return 'Description cannot contain angle brackets (< or >)';
  }
  if (description.length > 1024) {
    return `Description is too long (${description.length} characters). Maximum is 1024 characters.`;
  }
  return null;
}

async function validateSkill(skillPath: string): Promise<ValidationResult> {
  const skillMd = join(skillPath, 'SKILL.md');
  try {
    await stat(skillMd);
  } catch {
    return { valid: false, message: 'SKILL.md not found' };
  }

  const content = await Bun.file(skillMd).text();
  const frontmatter = parseFrontmatter(content);
  if ('error' in frontmatter) {
    return { valid: false, message: frontmatter.error };
  }

  const keys = extractTopLevelKeys(frontmatter.block);
  const unexpected = Array.from(keys.keys()).filter((key) => !ALLOWED_KEYS.has(key));
  if (unexpected.length > 0) {
    const allowed = Array.from(ALLOWED_KEYS.values()).sort().join(', ');
    const unexpectedKeys = unexpected.sort().join(', ');
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpectedKeys}. Allowed properties are: ${allowed}`,
    };
  }

  if (!keys.has('name')) {
    return { valid: false, message: "Missing 'name' in frontmatter" };
  }
  if (!keys.has('description')) {
    return { valid: false, message: "Missing 'description' in frontmatter" };
  }

  const name = keys.get('name') ?? '';
  const nameError = validateName(name);
  if (nameError) {
    return { valid: false, message: nameError };
  }

  const description = keys.get('description') ?? '';
  const descriptionError = validateDescription(description);
  if (descriptionError) {
    return { valid: false, message: descriptionError };
  }

  return { valid: true, message: 'Skill is valid!' };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    usage();
    process.exit(1);
  }

  const skillArg = args[0];
  if (!skillArg) {
    usage();
    process.exit(1);
  }

  const skillPath = resolve(skillArg);
  const outputDir = resolve(args[1] ?? process.cwd());

  let stats;
  try {
    stats = await stat(skillPath);
  } catch {
    console.error(`[ERROR] Skill folder not found: ${skillPath}`);
    process.exit(1);
  }

  if (!stats.isDirectory()) {
    console.error(`[ERROR] Path is not a directory: ${skillPath}`);
    process.exit(1);
  }

  if (outputDir.startsWith(`${skillPath}${process.platform === 'win32' ? '\\' : '/'}`)) {
    console.error('[ERROR] Output directory must be outside the skill folder.');
    process.exit(1);
  }

  console.log(`Packaging skill: ${skillPath}`);
  if (args[1]) {
    console.log(`   Output directory: ${outputDir}`);
  }
  console.log('');

  console.log('Validating skill...');
  const validation = await validateSkill(skillPath);
  if (!validation.valid) {
    console.error(`[ERROR] Validation failed: ${validation.message}`);
    console.error('   Please fix the validation errors before packaging.');
    process.exit(1);
  }
  console.log(`[OK] ${validation.message}`);
  console.log('');

  const zipPath = Bun.which('zip');
  if (!zipPath) {
    console.error('[ERROR] zip command not found. Install zip or add it to PATH.');
    process.exit(1);
  }

  await mkdir(outputDir, { recursive: true });

  const skillName = basename(skillPath);
  const outputFile = join(outputDir, `${skillName}.skill`);
  await rm(outputFile, { force: true });

  const parentDir = dirname(skillPath);
  const zipArgs = ['-r', outputFile, skillName, '-x', '**/.DS_Store'];

  const zipProcess = Bun.spawn([zipPath, ...zipArgs], {
    cwd: parentDir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await zipProcess.exited;
  if (exitCode !== 0) {
    console.error(`[ERROR] zip failed with exit code ${exitCode}`);
    process.exit(exitCode);
  }

  console.log('');
  console.log(`[OK] Successfully packaged skill to: ${outputFile}`);
}

await main();
