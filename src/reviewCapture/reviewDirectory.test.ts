import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { readReviewEvidence } from './evidence.js';
import {
  failureOf,
  inputHeader,
  savedArtifactState,
  preparedReview,
} from './fixtures/reviewDirectoryHarness.js';
import { captureReviewDirectory } from './generation.js';
import { checkReviewFreshness } from './pinnedCapture.js';
import { prepareReviewDirectory } from './reviewPrepare.js';
import { readSavedRecapture } from './savedRecapture.js';

type DirectoryOf = (root: string) => Promise<string>;

const inputText = '# Review input\n\n## Capture\n';

const repositoryWithEdit = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await writeFile(join(root, 'tracked.txt'), 'two\n');

  return root;
};

const stateOf = async (path: string): Promise<unknown[][] | string | null> => {
  const entry = await stat(path).catch(() => undefined);

  if (entry === undefined) {
    return null;
  }

  return entry.isDirectory() ? savedArtifactState(path) : readFile(path, 'utf8');
};

const operations = {
  capture: (root: string, directory: string) =>
    captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'HEAD' }),
  freshness: (root: string, directory: string) => checkReviewFreshness(root, directory),
  evidence: (root: string, directory: string) => readReviewEvidence(root, directory),
  savedRecapture: (root: string, directory: string) => readSavedRecapture(root, directory),
};

const refusedDirectories: [string, DirectoryOf, RegExp][] = [
  [
    'a directory outside .tau/workers',
    async (root) => {
      const outside = join(root, 'review-outside');

      await mkdir(outside);
      await writeFile(join(outside, 'input.md'), inputText);

      return outside;
    },
    /must be in \.tau\/workers/,
  ],
  [
    'a worker directory not named review-*',
    async (root) => {
      const task = join(root, '.tau/workers/task-1');

      await mkdir(task, { recursive: true });
      await writeFile(join(task, 'input.md'), inputText);

      return task;
    },
    /must be named review-\*/,
  ],
  [
    'a nested review directory',
    async (root) => {
      const nested = join(root, '.tau/workers/review-a/inner');

      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, 'input.md'), inputText);

      return nested;
    },
    /must sit directly in \.tau\/workers/,
  ],
  [
    'the workers directory itself',
    async (root) => {
      const workers = join(root, '.tau/workers');

      await mkdir(workers, { recursive: true });
      await writeFile(join(workers, 'input.md'), inputText);

      return workers;
    },
    /must be named review-\*/,
  ],
  [
    'a review directory that does not exist',
    async (root) => join(await prepareReviewDirectory(root, Date.now()), '..', 'review-absent'),
    /does not exist/,
  ],
  [
    'a review name that is a file',
    async (root) => {
      const file = join(await prepareReviewDirectory(root, Date.now()), '..', 'review-file');

      await writeFile(file, 'plain\n');

      return file;
    },
    /does not exist/,
  ],
  [
    'a review directory that is a symlink',
    async (root) => {
      const outside = temporaryDirectory(onTestFinished, 'tau-review-outside-');
      const link = join(root, '.tau/workers/review-linked');

      await prepareReviewDirectory(root, Date.now());
      await writeFile(join(outside, 'input.md'), inputText);
      await symlink(outside, link);

      return link;
    },
    /symlink/,
  ],
];

const refusalCases = Object.entries(operations).flatMap(([operation, operate]) =>
  refusedDirectories.map(([name, directoryOf, message]) => ({
    operation,
    name,
    operate,
    directoryOf,
    message,
  })),
);

it.each(refusalCases)(
  'the $operation operation refuses $name before it reads or writes',
  async ({ operate, directoryOf, message }) => {
    const root = await repositoryWithEdit();
    const directory = await directoryOf(root);
    const before = await stateOf(directory);

    await expect(operate(root, directory)).rejects.toThrow(message);

    expect(await stateOf(directory)).toEqual(before);
  },
);

it.each([
  { entry: 'capture', folder: false },
  { entry: 'capture/patch.diff', folder: true },
  { entry: 'capture/input.md', folder: true },
])('refuses a review directory whose $entry is a symlink', async ({ entry, folder }) => {
  const { root, directory } = await preparedReview();
  const outside = temporaryDirectory(onTestFinished, 'tau-review-outside-');

  if (folder) {
    await mkdir(join(directory, 'capture'));
  }

  await symlink(outside, join(directory, entry));
  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const before = await savedArtifactState(directory);

  expect(await failureOf(() => checkReviewFreshness(root, directory))).toContain('symlink');
  expect(await savedArtifactState(directory)).toEqual(before);
  expect(await readFile(join(directory, 'input.md'), 'utf8')).toBe(inputHeader);
  expect(await readdir(outside)).toEqual([]);
});
