import { mkdir, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { pruneTemporaryOutput } from './fullOutput.js';

const retentionMilliseconds = 24 * 60 * 60 * 1000;

const oldTimestamp = (now: number) => new Date(now - retentionMilliseconds - 1000);
const youngTimestamp = (now: number) => new Date(now - 1000);

it('removes only old directories for its prefix', async ({ onTestFinished }) => {
  const root = temporaryDirectory(onTestFinished, 'tau-output-retention-');
  const now = Date.now();
  const oldMatching = join(root, 'tau-output-old');
  const youngMatching = join(root, 'tau-output-young');
  const oldOther = join(root, 'tau-other-old');
  const oldFile = join(root, 'tau-output-file');

  for (const directory of [oldMatching, youngMatching, oldOther]) {
    await mkdir(directory);
    await writeFile(join(directory, 'output.log'), 'kept');
  }

  await writeFile(oldFile, 'not a directory');
  await utimes(oldMatching, oldTimestamp(now), oldTimestamp(now));
  await utimes(oldOther, oldTimestamp(now), oldTimestamp(now));
  await utimes(youngMatching, youngTimestamp(now), youngTimestamp(now));

  pruneTemporaryOutput(root, 'tau-output-', now);

  expect((await readdir(root)).toSorted()).toEqual(
    ['tau-other-old', 'tau-output-file', 'tau-output-young'].toSorted(),
  );
});

it('keeps a symlink that matches the prefix and leaves its target', async ({ onTestFinished }) => {
  const root = temporaryDirectory(onTestFinished, 'tau-output-retention-');
  const now = Date.now();
  const target = join(root, 'target');
  const link = join(root, 'tau-output-link');

  await mkdir(target);
  await writeFile(join(target, 'output.log'), 'kept');
  await symlink(target, link, 'dir');
  await utimes(link, oldTimestamp(now), oldTimestamp(now));

  pruneTemporaryOutput(root, 'tau-output-', now);

  expect((await readdir(root)).toSorted()).toEqual(['tau-output-link', 'target'].toSorted());
  expect(await readdir(target)).toEqual(['output.log']);
});
