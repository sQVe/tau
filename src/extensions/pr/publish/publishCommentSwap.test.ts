import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import {
  preparePublicationRun as prepareRun,
  publicationRepository as repository,
  setUpPublication,
  writeRunFile,
} from '../fixtures/publicationRun.js';

const hooks: { swap: { path: string; run: () => Promise<void> } | undefined } = {
  swap: undefined,
};

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    readFile: (async (...parameters: Parameters<typeof original.readFile>) => {
      const swap = hooks.swap;

      if (swap !== undefined && parameters[0] === swap.path) {
        hooks.swap = undefined;
        await swap.run();
      }

      return original.readFile(...parameters);
    }) as typeof original.readFile,
  };
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
