import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import type * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import {
  maximumWorkingBytes,
  readWorkingEntry,
  snapshotPreparation,
  workingState,
} from './preparation.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof fileSystem>();

  return { ...native, readFile: vi.fn<typeof readFile>(native.readFile) };
});

const execute = promisify(execFile);
const directories: string[] = [];
const git = async (root: string, arguments_: string[]) =>
  (await execute('git', arguments_, { cwd: root })).stdout.trim();
const pi: Pick<ExtensionAPI, 'exec'> = {
  async exec(command, arguments_, options) {
    const result = await execute(command, arguments_, { cwd: options?.cwd });

    return { ...result, code: 0, killed: false };
  },
};
const repository = async () => {
  const root = await mkdtemp(join(tmpdir(), 'tau-preparation-'));
  directories.push(root);
  await git(root, ['init']);
  await writeFile(join(root, 'file'), Buffer.from([0, 255, 13, 10]));

  return root;
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('keeps the preparation byte budget before reading an oversized entry', async () => {
  const root = await repository();
  const second = join(root, 'second');
  await writeFile(second, '');
  await truncate(second, maximumWorkingBytes);
  vi.mocked(readFile).mockClear();

  await expect(readWorkingEntry(root, 'file', 3)).rejects.toThrow(/100 MiB/);
  expect(vi.mocked(readFile).mock.calls).toHaveLength(0);
  await expect(workingState(root)).rejects.toThrow(/100 MiB/);
  expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === second)).toHaveLength(0);
});

it('discards its own recovery ref and archive', async () => {
  const root = await repository();
  await git(root, ['add', 'file']);
  const snapshot = await snapshotPreparation(pi, root, ['file']);
  const reference = (await readFile(join(snapshot.directory, 'recovery-ref'), 'utf8')).trim();

  await snapshot.discard();

  await expect(lstat(snapshot.directory)).rejects.toThrow(/ENOENT/);
  await expect(git(root, ['show-ref', '--verify', reference])).rejects.toThrow(/not a valid ref/);
});

it('refuses discard when another writer replaces the recovery ref', async () => {
  const root = await repository();
  await git(root, ['add', 'file']);
  const snapshot = await snapshotPreparation(pi, root, ['file']);
  const reference = (await readFile(join(snapshot.directory, 'recovery-ref'), 'utf8')).trim();
  await writeFile(join(root, 'file'), 'new staging');
  await git(root, ['add', 'file']);
  const replacement = await git(root, ['write-tree']);
  await git(root, ['update-ref', reference, replacement]);
  const index = await readFile(join(root, '.git/index'));

  await expect(snapshot.discard()).rejects.toThrow(/expected|is at/);

  expect(await git(root, ['rev-parse', reference])).toBe(replacement);
  expect((await lstat(snapshot.directory)).isDirectory()).toBe(true);
  expect(await readFile(join(snapshot.directory, 'working.json'), 'utf8')).toContain(
    Buffer.from([0, 255, 13, 10]).toString('base64'),
  );
  expect(await readFile(join(root, '.git/index'))).toEqual(index);
});
