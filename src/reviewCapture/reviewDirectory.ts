import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from '../errors.js';
import { checkTauDirectory, locateTauChild } from '../tauDirectory.js';
import { inputFileName, recheckFileName, recordFileName } from './record.js';

export const workersPath = 'workers';
export const reviewPrefix = 'review-';

export const existingEntry = (path: string): Promise<Stats | undefined> =>
  lstat(path).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  });

// A linked file could send the tool's writes, or the reviewer's reads, outside the repository.
const rejectLinkedFile = async (path: string) => {
  const entry = await existingEntry(path);

  if (entry?.isSymbolicLink() === true) {
    throw new Error(`Refusing to write through a symlink: ${path}`);
  }

  if (entry !== undefined && entry.nlink > 1) {
    throw new Error(`Refusing a review file with another hard link: ${path}`);
  }
};

const reviewName = (root: string, directory: string) => {
  const located = locateTauChild(root, workersPath, reviewPrefix, directory);

  if (located.kind !== 'child') {
    throw new Error(
      `The review directory must be .tau/workers/review-* from prepare, not ${directory}.`,
    );
  }

  return located.name;
};

// Refuses a review directory that a link could send outside the checkout, and changes nothing.
export const checkReviewDirectory = async (root: string, directory: string): Promise<string> => {
  const name = reviewName(root, directory);
  const path = join(root, '.tau', workersPath, name);

  await checkTauDirectory(root, `${workersPath}/${name}`);

  const entry = await existingEntry(path);

  if (entry?.isDirectory() !== true) {
    throw new Error(`The review directory ${path} does not exist. Run prepare first.`);
  }

  for (const file of [inputFileName, recordFileName, recheckFileName]) {
    // oxlint-disable-next-line no-await-in-loop -- three lstat calls; order keeps the first error stable.
    await rejectLinkedFile(join(path, file));
  }

  return path;
};
