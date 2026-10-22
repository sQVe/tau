import type { PathLike } from 'node:fs';
import { chmod, mkdir, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import {
  createDiagnosticsDirectory,
  finishDiagnostics,
  maximumRetainedRuns,
  pruneDiagnostics,
} from './retention.js';

// Hooks around each lstat let a test act as a concurrent prune at an exact point.
const lstatHook = vi.hoisted(() => ({
  before: undefined as ((path: string) => Promise<void>) | undefined,
  after: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  const lstat = async (path: PathLike) => {
    await lstatHook.before?.(String(path));
    const metadata = await actual.lstat(path);
    await lstatHook.after?.(String(path));

    return metadata;
  };

  return { ...actual, lstat: lstat as typeof actual.lstat };
});

const retentionMilliseconds = 7 * 24 * 60 * 60 * 1000;

const temporaryRoot = async (onTestFinished: TestContext['onTestFinished']) => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');

  return root;
};

const completedRun = async (root: string, name: string, finishedAt: number) => {
  const directory = join(root, name);

  await mkdir(directory);
  await writeFile(join(directory, 'completed'), '');
  await utimes(join(directory, 'completed'), new Date(finishedAt), new Date(finishedAt));

  return directory;
};

const stubAgentDirectory = async (onTestFinished: TestContext['onTestFinished']) => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-retention-root-');
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  onTestFinished(async () => {
    vi.unstubAllEnvs();
  });

  return agentDirectory;
};

it('retains recent completed runs while pruning old and excess diagnostics without touching active runs', async ({
  onTestFinished,
}) => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');
  const now = Date.now();
  const completed: string[] = [];

  for (let index = 0; index < maximumRetainedRuns + 2; index += 1) {
    const name = `run-${String(index).padStart(6, '0')}`;
    const directory = join(root, name);

    await mkdir(directory);
    await writeFile(join(directory, 'completed'), '');

    await utimes(
      join(directory, 'completed'),
      new Date(now - index * 1000),
      new Date(now - index * 1000),
    );

    completed.push(name);
  }

  const expired = join(root, 'run-expire');
  const abandoned = join(root, 'run-abando');
  const active = join(root, 'run-active');
  const unrelated = join(root, 'other-directory');

  for (const path of [expired, abandoned, active, unrelated]) {
    await mkdir(path);
  }

  await writeFile(join(expired, 'completed'), '');
  const old = new Date(now - 7 * 24 * 60 * 60 * 1000 - 1);
  await utimes(join(expired, 'completed'), old, old);
  await utimes(abandoned, old, old);
  await writeFile(join(unrelated, 'keep'), 'user data');
  await symlink(unrelated, join(root, 'run-linked'), 'dir');

  await pruneDiagnostics(root, now);

  expect((await readdir(root)).toSorted()).toEqual(
    [
      ...completed.slice(0, maximumRetainedRuns),
      'run-active',
      'run-linked',
      'other-directory',
    ].toSorted(),
  );

  expect(await readdir(unrelated)).toEqual(['keep']);

  const current = join(root, 'run-curren');
  await mkdir(current);
  await writeFile(join(current, 'completed'), '');
  await utimes(join(current, 'completed'), old, old);

  await pruneDiagnostics(root, now, current);

  expect((await readdir(root)).toSorted()).toEqual(
    [
      ...completed.slice(0, maximumRetainedRuns - 1),
      'run-curren',
      'run-active',
      'run-linked',
      'other-directory',
    ].toSorted(),
  );
});

it('rejects a symlink at the diagnostic storage root', async ({ onTestFinished }) => {
  const agentDirectory = await stubAgentDirectory(onTestFinished);
  const target = join(agentDirectory, 'other');

  await mkdir(target);
  await symlink(target, join(agentDirectory, 'test-runs'), 'dir');

  await expect(createDiagnosticsDirectory()).rejects.toThrow(
    'Expected a private diagnostic directory',
  );

  expect(await readdir(target)).toEqual([]);
});

it('keeps old directories whose names are not run directory names', async ({ onTestFinished }) => {
  const root = await temporaryRoot(onTestFinished);
  const now = Date.now();
  const old = new Date(now - retentionMilliseconds - 1000);
  const names = ['other-directory', 'xrun-abcdef', 'run-abcdefg'];

  for (const name of names) {
    await mkdir(join(root, name));
    await utimes(join(root, name), old, old);
  }

  await pruneDiagnostics(root, now);

  expect((await readdir(root)).toSorted()).toEqual(names.toSorted());
});

it('keeps the most recently completed runs whatever their names', async ({ onTestFinished }) => {
  const root = await temporaryRoot(onTestFinished);
  const now = Date.now();
  const runCount = maximumRetainedRuns + 8;
  const newest: string[] = [];

  for (let index = 0; index < runCount; index += 1) {
    // Spread ages so neither name nor creation order matches completion order.
    const age = (index * 7) % runCount;
    const name = `run-${String(index).padStart(6, '0')}`;

    await completedRun(root, name, now - age * 1000);

    if (age < maximumRetainedRuns) {
      newest.push(name);
    }
  }

  await pruneDiagnostics(root, now);

  expect((await readdir(root)).toSorted()).toEqual(newest.toSorted());
});

it('keeps a completed run until it is older than the retention period', async ({
  onTestFinished,
}) => {
  const root = await temporaryRoot(onTestFinished);
  const now = Date.now();

  await completedRun(root, 'run-edge00', now - retentionMilliseconds);
  await completedRun(root, 'run-older0', now - retentionMilliseconds - 1000);

  await pruneDiagnostics(root, now);

  expect(await readdir(root)).toEqual(['run-edge00']);
});

it('tolerates run directories that a concurrent prune removes while it runs', async ({
  onTestFinished,
}) => {
  const root = await temporaryRoot(onTestFinished);
  const now = Date.now();
  const listed = join(root, 'run-listed');
  const expired = await completedRun(root, 'run-expire', now - retentionMilliseconds - 1000);
  await completedRun(root, 'run-recent', now);
  await mkdir(listed);

  onTestFinished(() => {
    lstatHook.before = undefined;
    lstatHook.after = undefined;
  });

  lstatHook.before = async (path) => {
    if (path === listed) {
      await rm(listed, { recursive: true });
    }
  };

  lstatHook.after = async (path) => {
    if (path === join(expired, 'completed')) {
      await rm(expired, { recursive: true });
    }
  };

  await pruneDiagnostics(root, now);

  expect(await readdir(root)).toEqual(['run-recent']);
});

// Root bypasses directory permissions, and Windows chmod cannot deny directory traversal.
const chmodDeniesTraversal = process.platform !== 'win32' && process.getuid?.() !== 0;

it.skipIf(!chmodDeniesTraversal)(
  'fails a prune when a run directory cannot be read',
  async ({ onTestFinished }) => {
    const root = await temporaryRoot(onTestFinished);
    const locked = await completedRun(root, 'run-locked', Date.now() - retentionMilliseconds * 2);
    await chmod(locked, 0o600);

    onTestFinished(() => chmod(locked, 0o700));

    await expect(pruneDiagnostics(root)).rejects.toMatchObject({ code: 'EACCES' });
    expect(await readdir(root)).toEqual(['run-locked']);
  },
);

it('adds a retention failure to the diagnostics error', async ({ onTestFinished }) => {
  await stubAgentDirectory(onTestFinished);
  const directory = await createDiagnosticsDirectory();
  await rm(directory, { recursive: true });

  const diagnostics = {
    directory,
    durationMs: 1,
    timeoutMs: 30_000,
    started: true,
    command: ['vitest'],
    exitCode: 1,
    error: 'earlier failure',
  };

  await finishDiagnostics(diagnostics);

  expect(diagnostics.error).toContain('earlier failure');
  expect(diagnostics.error).toContain('ENOENT');
});

it.skipIf(process.getuid === undefined).for([
  { name: 'is shared with other users', mode: 0o755, uidOffset: 0 },
  { name: 'belongs to another user', mode: 0o700, uidOffset: 1 },
])(
  'rejects a diagnostic storage root that $name',
  async ({ mode, uidOffset }, { onTestFinished }) => {
    const agentDirectory = await stubAgentDirectory(onTestFinished);
    const root = join(agentDirectory, 'test-runs');
    await mkdir(root, { mode });
    await chmod(root, mode);

    const uid = process.getuid?.() ?? 0;
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(uid + uidOffset);

    onTestFinished(() => {
      getuid.mockRestore();
    });

    await expect(createDiagnosticsDirectory()).rejects.toThrow(
      'Expected a private diagnostic directory',
    );

    expect(await readdir(root)).toEqual([]);
  },
);
