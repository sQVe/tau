import { appendFile, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';

const hooks: {
  beforeOpen: (() => Promise<void>) | undefined;
  beforeRealpath: (() => Promise<void>) | undefined;
} = { beforeOpen: undefined, beforeRealpath: undefined };

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    open: async (...parameters: Parameters<typeof original.open>) => {
      await hooks.beforeOpen?.();

      return original.open(...parameters);
    },
    realpath: (async (...parameters: Parameters<typeof original.realpath>) => {
      await hooks.beforeRealpath?.();

      return original.realpath(...parameters);
    }) as typeof original.realpath,
  };
});

const { writeDestination } = await import('./destination.js');

it('refuses and leaves the outside file whole when a directory is swapped for a symlink before the open', async () => {
  const base = temporaryDirectory(onTestFinished, 'tau-destination-');

  const tauDirectory = join(base, '.tau');
  const outsideDirectory = join(base, 'outside');

  await mkdir(join(tauDirectory, 'slices'), { recursive: true });
  await mkdir(outsideDirectory);
  await writeFile(join(tauDirectory, 'slices/a.md'), 'original\n');
  await writeFile(join(outsideDirectory, 'a.md'), 'original\n');

  hooks.beforeOpen = async () => {
    hooks.beforeOpen = undefined;
    await rename(join(tauDirectory, 'slices'), join(tauDirectory, 'old-slices'));
    await symlink(outsideDirectory, join(tauDirectory, 'slices'));
  };

  await expect(
    writeDestination(tauDirectory, 'slices/a.md', 'edited\n', 'original\n'),
  ).rejects.toThrow(/slices\/a\.md/);

  expect(await readFile(join(outsideDirectory, 'a.md'), 'utf8')).toBe('original\n');
});

it('writes nothing and reports no write when the file disappears during the check', async () => {
  const base = temporaryDirectory(onTestFinished, 'tau-destination-');

  const tauDirectory = join(base, '.tau');
  const target = join(tauDirectory, 'slices/a.md');

  await mkdir(join(tauDirectory, 'slices'), { recursive: true });
  await writeFile(target, 'original\n');

  hooks.beforeRealpath = async () => {
    hooks.beforeRealpath = undefined;
    await rm(target);
  };

  await expect(
    writeDestination(tauDirectory, 'slices/a.md', 'edited\n', 'original\n'),
  ).resolves.toBe(false);

  await expect(readFile(target, 'utf8')).rejects.toThrow(/ENOENT/);
});

it('writes nothing when the file is rewritten in place after the check and no longer holds the expected content', async () => {
  const base = temporaryDirectory(onTestFinished, 'tau-destination-');

  const tauDirectory = join(base, '.tau');
  const target = join(tauDirectory, 'slices/a.md');

  await mkdir(join(tauDirectory, 'slices'), { recursive: true });
  await writeFile(target, 'original\n');

  hooks.beforeOpen = async () => {
    hooks.beforeOpen = undefined;
    await writeFile(target, 'agent edit\n');
  };

  await expect(
    writeDestination(tauDirectory, 'slices/a.md', 'edited\n', 'original\n'),
  ).resolves.toBe(false);

  expect(await readFile(target, 'utf8')).toBe('agent edit\n');
});

it('writes nothing when the file grows by an append after the open and before the content is read', async () => {
  const base = temporaryDirectory(onTestFinished, 'tau-destination-');

  const tauDirectory = join(base, '.tau');
  const target = join(tauDirectory, 'slices/a.md');

  await mkdir(join(tauDirectory, 'slices'), { recursive: true });
  await writeFile(target, 'original\n');

  // The first realpath runs before the open; the second runs after the handle's stat, before the read.
  let realpathCalls = 0;

  hooks.beforeRealpath = async () => {
    realpathCalls += 1;

    if (realpathCalls === 2) {
      hooks.beforeRealpath = undefined;
      await appendFile(target, 'agent append\n');
    }
  };

  await expect(
    writeDestination(tauDirectory, 'slices/a.md', 'edited\n', 'original\n'),
  ).resolves.toBe(false);

  expect(await readFile(target, 'utf8')).toBe('original\nagent append\n');
});

it('writes the edit when the expected content spans several read chunks', async () => {
  const base = temporaryDirectory(onTestFinished, 'tau-destination-');

  const tauDirectory = join(base, '.tau');
  const target = join(tauDirectory, 'slices/a.md');
  const largeContent = 'original line\n'.repeat(10_000);

  await mkdir(join(tauDirectory, 'slices'), { recursive: true });
  await writeFile(target, largeContent);

  await expect(
    writeDestination(tauDirectory, 'slices/a.md', 'edited\n', largeContent),
  ).resolves.toBe(true);

  expect(await readFile(target, 'utf8')).toBe('edited\n');
});

it('refuses when the checked folder is moved outside .tau and linked back before the open', async () => {
  const base = temporaryDirectory(onTestFinished, 'tau-destination-');

  const tauDirectory = join(base, '.tau');
  const movedDirectory = join(base, 'moved');

  await mkdir(join(tauDirectory, 'slices'), { recursive: true });
  await writeFile(join(tauDirectory, 'slices/a.md'), 'original\n');

  hooks.beforeOpen = async () => {
    hooks.beforeOpen = undefined;
    await rename(join(tauDirectory, 'slices'), movedDirectory);
    await symlink(movedDirectory, join(tauDirectory, 'slices'));
  };

  await expect(
    writeDestination(tauDirectory, 'slices/a.md', 'edited\n', 'original\n'),
  ).rejects.toThrow(/slices\/a\.md/);

  expect(await readFile(join(movedDirectory, 'a.md'), 'utf8')).toBe('original\n');
});
