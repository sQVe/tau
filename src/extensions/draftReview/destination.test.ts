import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

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
  const base = await mkdtemp(join(tmpdir(), 'tau-destination-'));
  onTestFinished(() => rm(base, { recursive: true, force: true }));

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

  await expect(writeDestination(tauDirectory, 'slices/a.md', 'edited\n')).rejects.toThrow(
    /slices\/a\.md/,
  );

  expect(await readFile(join(outsideDirectory, 'a.md'), 'utf8')).toBe('original\n');
});

it('writes nothing and reports no write when the file disappears during the check', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tau-destination-'));
  onTestFinished(() => rm(base, { recursive: true, force: true }));

  const tauDirectory = join(base, '.tau');
  const target = join(tauDirectory, 'slices/a.md');

  await mkdir(join(tauDirectory, 'slices'), { recursive: true });
  await writeFile(target, 'original\n');

  hooks.beforeRealpath = async () => {
    hooks.beforeRealpath = undefined;
    await rm(target);
  };

  await expect(writeDestination(tauDirectory, 'slices/a.md', 'edited\n')).resolves.toBe(false);
  await expect(readFile(target, 'utf8')).rejects.toThrow(/ENOENT/);
});
