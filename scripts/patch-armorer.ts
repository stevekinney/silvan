import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const distRoot = join(process.cwd(), 'node_modules', 'armorer', 'dist');
const srcRoot = join(distRoot, 'src');
const entryPoint = join(distRoot, 'index.js');

async function copyCompiledFiles(srcDir: string, destDir: string): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyCompiledFiles(srcPath, destPath);
      continue;
    }

    const ext = extname(entry.name);
    if (ext !== '.js' && ext !== '.cjs' && ext !== '.map') {
      continue;
    }

    await mkdir(destDir, { recursive: true });
    await copyFile(srcPath, destPath);
  }
}

if (!(await pathExists(entryPoint)) && (await pathExists(srcRoot))) {
  await copyCompiledFiles(srcRoot, distRoot);
}
