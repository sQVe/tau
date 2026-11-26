import { execFile } from 'node:child_process';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import {
  preparePublicationRun as prepareRun,
  publicationRepository as repository,
  setUpPublication,
  writeRunFile,
} from '../fixtures/publicationRun.js';

const runFile = promisify(execFile);

const hooks: { swap: { path: string; run: () => Promise<void> } | undefined } = {
  swap: undefined,
};

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    open: async (...parameters: Parameters<typeof original.open>) => {
      const swap = hooks.swap;

      if (swap !== undefined && parameters[0] === swap.path) {
        hooks.swap = undefined;
        await swap.run();
      }

      return original.open(...parameters);
    },
  };
});

afterEach(() => {
  hooks.swap = undefined;
});

it('refuses a comment file swapped for a symlink after the link check', async () => {
  const { fake, run } = await setUpPublication(onTestFinished);
  const directory = await prepareRun(run);
  const outside = temporaryDirectory(onTestFinished, 'tau-pr-outside-');
  const file = join(directory, 'comment.md');

  await writeRunFile(directory, 'comment.md', 'Looks good.\n');
  await writeFile(join(outside, 'comment.md'), 'Outside bytes.\n');

  hooks.swap = {
    path: file,
    run: async () => {
      await rm(file);
      await symlink(join(outside, 'comment.md'), file);
    },
  };

  await expect(
    run({ action: 'dryRun', kind: 'comment', repository, directory, pr: 7, file: 'comment.md' }),
  ).rejects.toThrow(/ELOOP/u);

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file swapped for a FIFO after the check', async () => {
  const { fake, run } = await setUpPublication(onTestFinished);
  const directory = await prepareRun(run);
  const file = join(directory, 'comment.md');

  await writeRunFile(directory, 'comment.md', 'Looks good.\n');

  hooks.swap = {
    path: file,
    run: async () => {
      await rm(file);
      await runFile('mkfifo', [file]);
    },
  };

  await expect(
    run({ action: 'dryRun', kind: 'comment', repository, directory, pr: 7, file: 'comment.md' }),
  ).rejects.toThrow('Refusing to read a path that is not a regular file');

  expect(fake.calls).toEqual([]);
});
