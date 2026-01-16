import { posix, win32 } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { resolveStatePaths } from './paths';

const provider = (data: string, cache: string) => () => ({
  data,
  cache,
  config: '/config',
  log: '/log',
  temp: '/temp',
});

describe('resolveStatePaths', () => {
  it('resolves global paths on macOS', () => {
    const paths = resolveStatePaths({
      repoRoot: '/repo',
      mode: 'global',
      repoId: 'repo-1',
      provider: provider(
        '/Users/alice/Library/Application Support/silvan',
        '/Users/alice/Library/Caches/silvan',
      ),
      pathImpl: posix,
    });

    expect(paths.runsDir).toBe(
      '/Users/alice/Library/Application Support/silvan/repos/repo-1/runs',
    );
    expect(paths.auditDir).toBe(
      '/Users/alice/Library/Application Support/silvan/repos/repo-1/audit',
    );
    expect(paths.cacheDir).toBe('/Users/alice/Library/Caches/silvan/repos/repo-1');
    expect(paths.conversationsDir).toBe(
      '/Users/alice/Library/Application Support/silvan/repos/repo-1/conversations',
    );
    expect(paths.artifactsDir).toBe(
      '/Users/alice/Library/Application Support/silvan/repos/repo-1/artifacts',
    );
    expect(paths.tasksDir).toBe(
      '/Users/alice/Library/Application Support/silvan/repos/repo-1/tasks',
    );
  });

  it('resolves global paths on Linux', () => {
    const paths = resolveStatePaths({
      repoRoot: '/repo',
      mode: 'global',
      repoId: 'repo-2',
      provider: provider('/home/alice/.local/share/silvan', '/home/alice/.cache/silvan'),
      pathImpl: posix,
    });

    expect(paths.runsDir).toBe('/home/alice/.local/share/silvan/repos/repo-2/runs');
    expect(paths.auditDir).toBe('/home/alice/.local/share/silvan/repos/repo-2/audit');
    expect(paths.cacheDir).toBe('/home/alice/.cache/silvan/repos/repo-2');
    expect(paths.conversationsDir).toBe(
      '/home/alice/.local/share/silvan/repos/repo-2/conversations',
    );
    expect(paths.artifactsDir).toBe(
      '/home/alice/.local/share/silvan/repos/repo-2/artifacts',
    );
    expect(paths.tasksDir).toBe('/home/alice/.local/share/silvan/repos/repo-2/tasks');
  });

  it('resolves global paths on Windows', () => {
    const paths = resolveStatePaths({
      repoRoot: 'C:\\repo',
      mode: 'global',
      repoId: 'repo-3',
      provider: provider(
        'C:\\Users\\Alice\\AppData\\Roaming\\silvan',
        'C:\\Users\\Alice\\AppData\\Local\\silvan\\Cache',
      ),
      pathImpl: win32,
    });

    expect(paths.runsDir).toBe(
      'C:\\Users\\Alice\\AppData\\Roaming\\silvan\\repos\\repo-3\\runs',
    );
    expect(paths.auditDir).toBe(
      'C:\\Users\\Alice\\AppData\\Roaming\\silvan\\repos\\repo-3\\audit',
    );
    expect(paths.cacheDir).toBe(
      'C:\\Users\\Alice\\AppData\\Local\\silvan\\Cache\\repos\\repo-3',
    );
    expect(paths.conversationsDir).toBe(
      'C:\\Users\\Alice\\AppData\\Roaming\\silvan\\repos\\repo-3\\conversations',
    );
    expect(paths.artifactsDir).toBe(
      'C:\\Users\\Alice\\AppData\\Roaming\\silvan\\repos\\repo-3\\artifacts',
    );
    expect(paths.tasksDir).toBe(
      'C:\\Users\\Alice\\AppData\\Roaming\\silvan\\repos\\repo-3\\tasks',
    );
  });
});
