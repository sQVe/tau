import { lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { onTestFinished } from 'vitest';

import { installCommandShim } from '../../../tests/commandShimFake.js';
import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { captureReviewDirectory } from '../generation.js';
import type { CapturedGeneration } from '../generation.js';
import { prepareReviewDirectory } from '../reviewPrepare.js';

export const failureOf = (operation: () => Promise<unknown>): Promise<string> =>
  operation().then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

export const inputHeader = '# Review input\n\nTarget: the working tree.\n\n## Capture\n';

const committedRepository = async (): Promise<string> => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'first');

  return root;
};

export const preparedReview = async (): Promise<{ root: string; directory: string }> => {
  const root = await committedRepository();
  const directory = await prepareReviewDirectory(root, Date.now());

  await writeFile(join(directory, 'input.md'), inputHeader);

  return { root, directory };
};

export const captureWorkingTree = (root: string, directory: string): Promise<CapturedGeneration> =>
  captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'HEAD' });

export const savedArtifactState = async (directory: string): Promise<unknown[][]> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const paths = entries.map((entry) => join(entry.parentPath, entry.name)).toSorted();

  return Promise.all(
    paths.map(async (path) => {
      const name = relative(directory, path);
      const status = await lstat(path);
      const mode = status.mode & 0o777;

      if (status.isSymbolicLink()) {
        return [name, 'link', await readlink(path), mode];
      }

      if (status.isDirectory()) {
        return [name, 'directory', mode];
      }

      return [name, 'file', (await readFile(path)).toString('base64'), mode];
    }),
  );
};

export const prepareDirectory = async (root: string): Promise<string> => {
  const directory = await prepareReviewDirectory(root, Date.now());

  await writeFile(join(directory, 'input.md'), inputHeader);

  return directory;
};

export const failGitCommand = async (failing: string): Promise<void> => {
  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [{ match: ` ${failing} `, script: "echo 'forced failure' >&2; exit 2" }],
  });
};

export const fixRepository = async (): Promise<string> => {
  const root = await createTemporaryRepository(onTestFinished);

  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'math.ts'), 'export const add = (a, b) => a + b;\n');
  await writeFile(join(root, 'src', 'use.ts'), "import { add } from './math.js';\nadd(1, 2);\n");
  await writeFile(join(root, 'src', 'other.ts'), 'export const other = 1;\n');
  await git(root, 'add', '--all');
  await git(root, 'commit', '--quiet', '-m', 'first');

  return root;
};
