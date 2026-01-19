import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import * as lockfile from 'proper-lockfile/index.js';

import { hashString } from '../utils/hash';
import { resolveStatePaths, type StateMode } from './paths';

export type StateStore = {
  root: string;
  repoId: string;
  runsDir: string;
  auditDir: string;
  cacheDir: string;
  conversationsDir: string;
  artifactsDir: string;
  tasksDir: string;
  queueDir: string;
  stateVersion: string;
  lockRelease: () => Promise<void>;
  writeRunState: (runId: string, data: RunStateData) => Promise<string>;
  readRunState: (runId: string) => Promise<RunStateEnvelope | null>;
  updateRunState: (
    runId: string,
    updater: (data: RunStateData) => RunStateData,
  ) => Promise<string>;
};

export type RunStateData = Record<string, unknown>;

export type RunStateEnvelope = {
  version: string;
  runId: string;
  data: RunStateData;
};

export type StateStoreOptions = {
  lock?: boolean;
  mode?: StateMode;
  root?: string;
};

export type StateMetadata = {
  notifiedAt?: string;
  repoRoot?: string;
  repoLabel?: string;
  lastAccessedAt?: string;
};

const stateVersion = '1.0.0';

export async function initStateStore(
  repoRoot: string,
  options?: StateStoreOptions,
): Promise<StateStore> {
  const mode = options?.mode ?? 'global';
  const paths = resolveStatePaths({
    repoRoot,
    mode,
    ...(options?.root ? { stateRoot: options.root } : {}),
  });
  const {
    root,
    runsDir,
    auditDir,
    cacheDir,
    metadataPath,
    artifactsDir,
    tasksDir,
    queueDir,
  } = paths;

  await mkdir(runsDir, { recursive: true });
  await mkdir(auditDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await mkdir(paths.conversationsDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(tasksDir, { recursive: true });
  await mkdir(queueDir, { recursive: true });

  const lockRelease =
    options?.lock === false
      ? async () => {}
      : ((await lockfile.lock(root, {
          retries: { retries: 2, factor: 2, minTimeout: 100, maxTimeout: 1000 },
        })) as () => Promise<void>);

  if (mode === 'global') {
    await ensureGlobalNotice({
      metadataPath,
      dataRoot: paths.dataRoot,
    });
  }
  await updateRepoMetadata({
    metadataPath,
    repoRoot,
  });

  async function writeRunState(runId: string, data: RunStateData): Promise<string> {
    const envelope: RunStateEnvelope = {
      version: stateVersion,
      runId,
      data,
    };
    const payload = JSON.stringify(envelope, null, 2);
    const target = join(runsDir, `${runId}.json`);
    const temp = join(runsDir, `${runId}.${crypto.randomUUID()}.tmp`);

    await writeFile(temp, payload, 'utf8');
    await rename(temp, target);

    return hashString(payload);
  }

  async function readRunState(runId: string): Promise<RunStateEnvelope | null> {
    const path = join(runsDir, `${runId}.json`);
    try {
      const parsed = JSON.parse(await Bun.file(path).text()) as RunStateEnvelope;
      if (parsed && parsed.version && parsed.runId && 'data' in parsed) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function updateRunState(
    runId: string,
    updater: (data: RunStateData) => RunStateData,
  ): Promise<string> {
    const current = await readRunState(runId);
    const next = updater(current?.data ?? {});
    return writeRunState(runId, next);
  }

  return {
    root,
    repoId: paths.repoId,
    runsDir,
    auditDir,
    cacheDir,
    conversationsDir: paths.conversationsDir,
    artifactsDir,
    tasksDir,
    queueDir,
    stateVersion,
    lockRelease,
    writeRunState,
    readRunState,
    updateRunState,
  };
}

async function ensureGlobalNotice(options: {
  metadataPath: string;
  dataRoot: string;
}): Promise<void> {
  const metadata = await readMetadata(options.metadataPath);
  if (metadata.notifiedAt) return;

  console.warn(`Silvan state is stored in ${options.dataRoot}.`);
  await writeMetadata(options.metadataPath, {
    notifiedAt: new Date().toISOString(),
  });
}

export async function readStateMetadata(path: string): Promise<StateMetadata> {
  return readMetadata(path);
}

export async function updateRepoMetadata(options: {
  metadataPath: string;
  repoRoot: string;
  repoLabel?: string;
}): Promise<void> {
  const current = await readMetadata(options.metadataPath);
  const fallbackLabel = basename(options.repoRoot) || options.repoRoot;
  const next: StateMetadata = {
    repoRoot: options.repoRoot,
    repoLabel: options.repoLabel ?? current.repoLabel ?? fallbackLabel,
    lastAccessedAt: new Date().toISOString(),
  };
  await writeMetadata(options.metadataPath, next);
}

async function readMetadata(path: string): Promise<StateMetadata> {
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as StateMetadata;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function writeMetadata(path: string, update: StateMetadata): Promise<void> {
  const current = await readMetadata(path);
  const next: StateMetadata = {
    ...current,
    ...update,
  };
  const payload = JSON.stringify(next, null, 2);
  await mkdir(dirname(path), { recursive: true });
  const base = basename(path);
  const temp = join(dirname(path), `${base}.${crypto.randomUUID()}.tmp`);
  await writeFile(temp, payload, 'utf8');
  await rename(temp, path);
}
