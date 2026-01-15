import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as lockfile from 'proper-lockfile/index.js';

import { hashString } from '../utils/hash';

export type StateStore = {
  root: string;
  runsDir: string;
  auditDir: string;
  lockRelease: () => Promise<void>;
  writeRunState: (runId: string, data: unknown) => Promise<string>;
  readRunState: (runId: string) => Promise<RunStateEnvelope | null>;
};

export type RunStateEnvelope = {
  version: string;
  runId: string;
  data: unknown;
};

const stateVersion = '1.0.0';

export async function initStateStore(repoRoot: string): Promise<StateStore> {
  const root = join(repoRoot, '.silvan');
  const runsDir = join(root, 'runs');
  const auditDir = join(root, 'audit');

  await mkdir(runsDir, { recursive: true });
  await mkdir(auditDir, { recursive: true });

  const lockRelease = (await lockfile.lock(root, {
    retries: { retries: 2, factor: 2, minTimeout: 100, maxTimeout: 1000 },
  })) as () => Promise<void>;

  async function writeRunState(runId: string, data: unknown): Promise<string> {
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
      return {
        version: '0.0.0',
        runId,
        data: parsed,
      };
    } catch {
      return null;
    }
  }

  return {
    root,
    runsDir,
    auditDir,
    lockRelease,
    writeRunState,
    readRunState,
  };
}
