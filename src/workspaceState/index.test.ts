import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWorkspaceState, WorkspaceStateVersionError } from './index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'tau-workspace-state-'));
  tempDirs.push(root);
  return root;
};

const statePath = (root: string) => join(root, '.tau', 'state.json');
const backupPath = (root: string) => join(root, '.tau', 'state.json.bak');
const writeStateFile = async (root: string, content: string): Promise<void> => {
  const file = statePath(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
};

describe('createWorkspaceState', () => {
  it('returns an empty object for a fresh namespace when no state file exists', async () => {
    const root = await createTempRoot();
    const workspaceState = createWorkspaceState(root);

    await expect(workspaceState.namespace('commit').get()).resolves.toEqual({});
    await expect(readdir(join(root, '.tau'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes under one namespace and reads the same value back', async () => {
    const root = await createTempRoot();
    const workspaceState = createWorkspaceState(root);
    const namespace = workspaceState.namespace<{ count: number; nested: { label: string } }>(
      'commit',
    );

    await namespace.set({ count: 1, nested: { label: 'alpha' } });

    await expect(namespace.get()).resolves.toEqual({ count: 1, nested: { label: 'alpha' } });
  });

  it('keeps namespaces isolated from one another', async () => {
    const root = await createTempRoot();
    const workspaceState = createWorkspaceState(root);
    const commitNamespace = workspaceState.namespace<{ count: number }>('commit');
    const tddNamespace = workspaceState.namespace<{ ready: boolean }>('tdd');

    await commitNamespace.set({ count: 1 });

    await expect(commitNamespace.get()).resolves.toEqual({ count: 1 });
    await expect(tddNamespace.get()).resolves.toEqual({});
  });

  it('creates the .tau directory on the first write', async () => {
    const root = await createTempRoot();
    const workspaceState = createWorkspaceState(root);

    await workspaceState.namespace('commit').set({ value: 'alpha' });

    await expect(readFile(statePath(root), 'utf8')).resolves.toContain('alpha');
  });

  it('quarantines corrupt JSON to state.json.bak and resets the load to empty state', async () => {
    const root = await createTempRoot();
    await writeStateFile(root, '{not-json');
    const workspaceState = createWorkspaceState(root);

    await expect(workspaceState.namespace('commit').get()).resolves.toEqual({});
    await expect(readFile(backupPath(root), 'utf8')).resolves.toBe('{not-json');
    await expect(readFile(statePath(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a mismatching version with a clear error and quarantines the file', async () => {
    const root = await createTempRoot();
    await writeStateFile(
      root,
      JSON.stringify({ version: 2, namespaces: { commit: { count: 1 } } }),
    );
    const workspaceState = createWorkspaceState(root);

    await expect(workspaceState.namespace('commit').get()).rejects.toBeInstanceOf(
      WorkspaceStateVersionError,
    );
    await expect(readFile(backupPath(root), 'utf8')).resolves.toContain('"version":2');
  });

  it.each([
    ['missing version', { namespaces: { commit: { count: 1 } } }, '"commit"'],
    ['invalid namespaces', { version: 1, namespaces: null }, '"namespaces":null'],
  ])(
    'rejects %s with the version error and quarantines the file',
    async (_label, envelope, expectedBackupSnippet) => {
      const root = await createTempRoot();
      await writeStateFile(root, JSON.stringify(envelope));
      const workspaceState = createWorkspaceState(root);

      await expect(workspaceState.namespace('commit').get()).rejects.toBeInstanceOf(
        WorkspaceStateVersionError,
      );
      await expect(readFile(backupPath(root), 'utf8')).resolves.toContain(expectedBackupSnippet);
    },
  );

  it('serializes concurrent read-modify-write updates through the advisory lock', async () => {
    const root = await createTempRoot();
    const workspaceState = createWorkspaceState(root);
    const counter = workspaceState.namespace<{ count: number }>('commit');

    await counter.set({ count: 0 });

    await Promise.all(
      [0, 1].map(() =>
        Array.from({ length: 100 }).reduce(
          (promise: Promise<void>) =>
            promise.then(() => counter.patch((current) => ({ count: current.count + 1 }))),
          Promise.resolve(),
        ),
      ),
    );

    await expect(counter.get()).resolves.toEqual({ count: 200 });
  });

  it('leaves the current file unchanged when the atomic rename step fails and removes the stale tmp file on the next successful write', async () => {
    const root = await createTempRoot();
    const workspaceState = createWorkspaceState(root);
    const namespace = workspaceState.namespace<{ value: string }>('commit');

    await namespace.set({ value: 'old' });

    const failingWorkspaceState = createWorkspaceState(root, {
      rename: () => Promise.reject(new Error('simulated crash')),
    });

    await expect(failingWorkspaceState.namespace('commit').set({ value: 'new' })).rejects.toThrow(
      /simulated crash/,
    );
    await expect(readFile(statePath(root), 'utf8')).resolves.toContain('old');

    const tempEntriesAfterFailure = await readdir(join(root, '.tau'));
    expect(tempEntriesAfterFailure.some((entry) => entry.startsWith('state.json.tmp.'))).toBe(true);

    const recoveredWorkspaceState = createWorkspaceState(root);
    await recoveredWorkspaceState.namespace('commit').set({ value: 'new' });

    const tempEntriesAfterRecovery = await readdir(join(root, '.tau'));
    expect(tempEntriesAfterRecovery.some((entry) => entry.startsWith('state.json.tmp.'))).toBe(
      false,
    );
    await expect(readFile(statePath(root), 'utf8')).resolves.toContain('new');
  });

  it('rejects non-plain-object values from set with a TypeError', async () => {
    const root = await createTempRoot();
    const workspaceState = createWorkspaceState(root);
    const namespace = workspaceState.namespace('commit');

    await expect(namespace.set([] as unknown as Record<string, unknown>)).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      namespace.set(Object.create(null) as Record<string, unknown>),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects patch updaters that return non-plain objects with a TypeError', async () => {
    const root = await createTempRoot();
    const workspaceState = createWorkspaceState(root);
    const namespace = workspaceState.namespace('commit');

    await expect(
      namespace.patch(() => [] as unknown as Record<string, unknown>),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('returns a deep copy from get so callers cannot mutate internal state', async () => {
    const root = await createTempRoot();
    const workspaceState = createWorkspaceState(root);
    const namespace = workspaceState.namespace<{ nested: { count: number } }>('commit');

    await namespace.set({ nested: { count: 1 } });

    const firstRead = await namespace.get();
    firstRead.nested.count = 99;

    await expect(namespace.get()).resolves.toEqual({ nested: { count: 1 } });
  });
});
