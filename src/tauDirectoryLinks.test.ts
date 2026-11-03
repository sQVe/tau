import { execFile } from 'node:child_process';
import {
  link as hardLink,
  lstat,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished as afterThisTest } from 'vitest';
import type { TestContext } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.js';
import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.js';
import {
  checkTauDirectory,
  ensureTauDirectory,
  existingEntry,
  rejectLinkedEntries,
  rejectLinkedFile,
} from './tauDirectory.js';

const listTree = async (directory: string) =>
  (await readdir(directory, { recursive: true })).toSorted();

const symlinkCases = [
  { name: '.tau', link: '.tau' },
  { name: 'the target directory', link: '.tau/slices/me-479' },
  { name: 'a directory between .tau and the target', link: '.tau/slices' },
  { name: '.tau/.gitignore', link: '.tau/.gitignore' },
];

for (const { name, link } of symlinkCases) {
  it(`refuses when ${name} is a symlink and creates nothing`, async ({ onTestFinished }) => {
    const root = temporaryDirectory(onTestFinished, 'tau-directory-');
    const outside = temporaryDirectory(onTestFinished, 'tau-directory-');

    await mkdir(join(root, link, '..'), { recursive: true });
    await symlink(outside, join(root, link));

    const before = await listTree(root);

    await expect(ensureTauDirectory(root, 'slices/me-479')).rejects.toThrow(link);

    expect(await listTree(root)).toEqual(before);
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(join(root, link))).isSymbolicLink()).toBe(true);
  });
}

const hardLinkedIgnoreFile = async (registerCleanup: TestContext['onTestFinished']) => {
  const root = await createTemporaryRepository(registerCleanup);
  const outside = temporaryDirectory(registerCleanup, 'tau-directory-');
  const outsideFile = join(outside, 'ignore');

  await writeFile(outsideFile, 'outside bytes\n');
  await mkdir(join(root, '.tau'));
  await hardLink(outsideFile, join(root, '.tau', '.gitignore'));

  return { root, outsideFile };
};

it('refuses a hard-linked .tau/.gitignore and leaves the linked file unchanged', async ({
  onTestFinished,
}) => {
  const { root, outsideFile } = await hardLinkedIgnoreFile(onTestFinished);
  const before = await listTree(root);

  await expect(ensureTauDirectory(root, 'slices/me-479')).rejects.toThrow('hard link');

  expect(await readFile(outsideFile, 'utf8')).toBe('outside bytes\n');
  expect(await listTree(root)).toEqual(before);
});

it('check refuses a hard-linked .tau/.gitignore', async ({ onTestFinished }) => {
  const { root, outsideFile } = await hardLinkedIgnoreFile(onTestFinished);

  await writeFile(outsideFile, '*\n');

  const before = await listTree(root);

  await expect(checkTauDirectory(root, 'slices')).rejects.toThrow('hard link');

  expect(await readFile(outsideFile, 'utf8')).toBe('*\n');
  expect(await listTree(root)).toEqual(before);
});

const acceptedFileCases = [
  { name: 'a missing path', setup: async () => undefined },
  { name: 'a plain file', setup: (path: string) => writeFile(path, 'text\n') },
  { name: 'a directory', setup: (path: string) => mkdir(path) },
];

const refusedFileCases = [
  {
    name: 'a symlink',
    kind: 'a symlink',
    setup: async (path: string) => {
      const target = join(temporaryDirectory(afterThisTest, 'tau-linked-file-'), 'target.md');

      await writeFile(target, 'text\n');
      await symlink(target, path);
    },
  },
  {
    name: 'a hard-linked file',
    kind: 'a file with another hard link',
    setup: async (path: string) => {
      const other = join(temporaryDirectory(afterThisTest, 'tau-linked-file-'), 'other.md');

      await writeFile(other, 'text\n');
      await hardLink(other, path);
    },
  },
  {
    name: 'a FIFO',
    kind: 'a file that is not a regular file',
    setup: async (path: string) => {
      await promisify(execFile)('mkfifo', [path]);
    },
  },
];

for (const verb of ['read', 'write'] as const) {
  for (const { name, setup } of acceptedFileCases) {
    it(`rejectLinkedFile for ${verb} accepts ${name}`, async () => {
      const path = join(temporaryDirectory(afterThisTest, 'tau-linked-file-'), 'file.md');

      await setup(path);

      await expect(rejectLinkedFile(path, verb)).resolves.toBeUndefined();
    });
  }

  for (const { name, kind, setup } of refusedFileCases) {
    it(`rejectLinkedFile for ${verb} refuses ${name}`, async () => {
      const path = join(temporaryDirectory(afterThisTest, 'tau-linked-file-'), 'file.md');

      await setup(path);

      await expect(rejectLinkedFile(path, verb)).rejects.toThrow(
        `Refusing to ${verb} through ${kind}: ${path}`,
      );
    });
  }
}

it('rejectLinkedFile rethrows an lstat error other than a missing file', async () => {
  const parent = join(temporaryDirectory(afterThisTest, 'tau-linked-file-'), 'plain.md');

  await writeFile(parent, 'text\n');

  await expect(rejectLinkedFile(join(parent, 'file.md'), 'read')).rejects.toThrow('ENOTDIR');
});

it('rejectLinkedEntries accepts a directory with a subdirectory and a plain file', async () => {
  const directory = temporaryDirectory(afterThisTest, 'tau-linked-entries-');

  await mkdir(join(directory, 'notes'));
  await writeFile(join(directory, 'slice-1.md'), 'text\n');

  await expect(rejectLinkedEntries(directory)).resolves.toBeUndefined();
});

it('rejectLinkedEntries refuses an entry with another hard link and leaves the other file', async () => {
  const directory = temporaryDirectory(afterThisTest, 'tau-linked-entries-');
  const outside = join(temporaryDirectory(afterThisTest, 'tau-linked-outside-'), 'secret.md');

  await writeFile(outside, 'Not for Linear.\n');
  await hardLink(outside, join(directory, 'slice-1.md'));

  await expect(rejectLinkedEntries(directory)).rejects.toThrow(/hard link: .*slice-1\.md$/);
  expect(await readFile(outside, 'utf8')).toBe('Not for Linear.\n');
});

it('rejectLinkedEntries refuses a symlinked entry', async () => {
  const directory = temporaryDirectory(afterThisTest, 'tau-linked-entries-');

  await symlink(directory, join(directory, 'loop'));

  await expect(rejectLinkedEntries(directory)).rejects.toThrow(/symlink: .*loop$/);
});

it('existingEntry reports a missing path as undefined', async () => {
  const directory = temporaryDirectory(afterThisTest, 'tau-entry-');

  expect(await existingEntry(join(directory, 'absent'))).toBeUndefined();
});

it('existingEntry reports a file and a directory as they are', async () => {
  const directory = temporaryDirectory(afterThisTest, 'tau-entry-');

  await writeFile(join(directory, 'file.txt'), 'text\n');
  await mkdir(join(directory, 'folder'));

  expect((await existingEntry(join(directory, 'file.txt')))?.isFile()).toBe(true);
  expect((await existingEntry(join(directory, 'folder')))?.isDirectory()).toBe(true);
});

it('existingEntry reports a symbolic link itself and does not follow it', async () => {
  const directory = temporaryDirectory(afterThisTest, 'tau-entry-');
  const target = join(directory, 'target');

  await writeFile(target, 'text\n');
  await symlink(target, join(directory, 'link'));

  const entry = await existingEntry(join(directory, 'link'));

  expect(entry?.isSymbolicLink()).toBe(true);
  expect(entry?.isFile()).toBe(false);
});

it('existingEntry throws an error that is not a missing file', async () => {
  const directory = temporaryDirectory(afterThisTest, 'tau-entry-');

  await writeFile(join(directory, 'file.txt'), 'text\n');

  await expect(existingEntry(join(directory, 'file.txt', 'child'))).rejects.toMatchObject({
    code: 'ENOTDIR',
  });
});
