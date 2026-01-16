#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import envPaths from 'env-paths';

import pkg from '../package.json' assert { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RELEASE_BASE =
  process.env.SILVAN_RELEASE_BASE ??
  'https://github.com/stevekinney/silvan/releases/download';

function resolveTarget() {
  const { platform, arch } = process;

  if (platform === 'darwin' && arch === 'x64') return { target: 'darwin-x64' };
  if (platform === 'darwin' && arch === 'arm64') return { target: 'darwin-arm64' };
  if (platform === 'linux' && arch === 'x64') return { target: 'linux-x64' };
  if (platform === 'linux' && arch === 'arm64') return { target: 'linux-arm64' };
  if (platform === 'win32' && arch === 'x64') return { target: 'windows-x64' };

  return null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        const redirect = response.headers.location;
        if (redirect) {
          response.resume();
          download(redirect, destination).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        reject(
          new Error(`Failed to download ${url} (status ${response.statusCode ?? 'unknown'})`),
        );
        response.resume();
        return;
      }

      const temp = `${destination}.tmp-${process.pid}`;
      const file = fs.createWriteStream(temp);
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(temp, destination);
          resolve();
        });
      });
      file.on('error', (error) => {
        try {
          fs.unlinkSync(temp);
        } catch {
          // ignore
        }
        reject(error);
      });
    });

    request.on('error', reject);
  });
}

async function ensureBinary() {
  const target = resolveTarget();
  if (!target) {
    throw new Error(
      `Unsupported platform: ${process.platform} ${process.arch}. ` +
        'No prebuilt Silvan binary is available.',
    );
  }

  const version = pkg.version;
  const ext = target.target.startsWith('windows') ? '.exe' : '';
  const assetName = `silvan-${target.target}${ext}`;
  const cacheRoot = envPaths('silvan').cache;
  const binDir = path.join(cacheRoot, 'bin');
  ensureDir(binDir);

  const binaryPath = path.join(binDir, assetName);
  if (!fs.existsSync(binaryPath)) {
    const url = `${RELEASE_BASE}/v${version}/${assetName}`;
    await download(url, binaryPath);
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }
  }

  return binaryPath;
}

function runFromSource() {
  const srcEntry = path.join(__dirname, '..', 'src', 'index.ts');
  const args = process.argv.slice(2);
  const result = spawnSync('bun', [srcEntry, ...args], { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

try {
  const binary = await ensureBinary();
  const args = process.argv.slice(2);
  const result = spawnSync(binary, args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} catch (error) {
  // If binary download fails, try running from source (dev mode)
  try {
    process.exitCode = runFromSource();
  } catch (sourceError) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
