#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import envPaths from 'env-paths';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RELEASE_BASE =
  process.env.SILVAN_RELEASE_BASE ??
  'https://github.com/stevekinney/silvan/releases/download';

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const pkgVersion = readPackageVersion();

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

function hasBun() {
  const result = spawnSync('bun', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function resolveSourceEntry() {
  return path.join(__dirname, '..', 'src', 'index.ts');
}

function canRunFromSource() {
  const srcEntry = resolveSourceEntry();
  return fs.existsSync(srcEntry) && hasBun();
}

function runFromSource() {
  const srcEntry = resolveSourceEntry();
  const args = process.argv.slice(2);
  const result = spawnSync('bun', [srcEntry, ...args], { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function resolveBinaryInfo() {
  const target = resolveTarget();
  if (!target) return null;
  const ext = target.target.startsWith('windows') ? '.exe' : '';
  const assetName = `silvan-${target.target}${ext}`;
  const url = `${RELEASE_BASE}/v${pkgVersion}/${assetName}`;
  return { target: target.target, assetName, url };
}

async function ensureBinary() {
  const info = resolveBinaryInfo();
  if (!info) {
    throw new Error(
      `Unsupported platform: ${process.platform} ${process.arch}. ` +
        'No prebuilt Silvan binary is available.',
    );
  }

  const cacheRoot = envPaths('silvan').cache;
  const binDir = path.join(cacheRoot, 'bin');
  ensureDir(binDir);

  const binaryPath = path.join(binDir, info.assetName);
  if (!fs.existsSync(binaryPath)) {
    await download(info.url, binaryPath);
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }
  }

  return { binaryPath, url: info.url, target: info.target };
}

function formatBinaryFailure(error, info) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Unsupported platform')) {
    return [
      message,
      'Install Bun and retry with SILVAN_DEV=1 to run from source.',
    ].join('\n');
  }
  const hints = [
    'Silvan failed to download the prebuilt binary.',
    message,
    `Version: v${pkgVersion}`,
    `Target: ${info.target}`,
    `URL: ${info.url}`,
    'Check your network or install Bun and retry with SILVAN_DEV=1.',
  ];
  return hints.join('\n');
}

const preferSource = process.env.SILVAN_DEV === '1' || process.env.SILVAN_DEV === 'true';

try {
  if (preferSource && canRunFromSource()) {
    process.exitCode = runFromSource();
  } else {
    const { binaryPath } = await ensureBinary();
    const args = process.argv.slice(2);
    const result = spawnSync(binaryPath, args, { stdio: 'inherit' });
    if (result.error) {
      throw result.error;
    }
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  if (canRunFromSource()) {
    try {
      process.exitCode = runFromSource();
      process.exit(process.exitCode ?? 1);
    } catch {
      // Fall through to error output.
    }
  }
  const resolvedInfo = resolveBinaryInfo();
  const info = resolvedInfo ?? { target: 'unknown', url: 'unknown' };
  console.error(formatBinaryFailure(error, info));
  process.exitCode = 1;
}
