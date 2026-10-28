import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from '../errors.js';
import { checkTauDirectory, rejectLinkedFile, requireTauChild } from '../tauDirectory.js';
import {
  generationFolderName,
  generationInputFileName,
  generationPatchFileName,
  inputFileName,
  recheckFileName,
  recordFileName,
} from './record.js';

export const workersPath = 'workers';
export const reviewPrefix = 'review-';

export const existingEntry = (path: string): Promise<Stats | undefined> =>
  lstat(path).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  });

const reviewName = (root: string, directory: string) =>
  requireTauChild(root, workersPath, reviewPrefix, directory, 'The review directory');

// Refuses a review directory that a link could send outside the checkout, and changes nothing.
export const reviewDirectoryPath = (root: string, directory: string): string =>
  join(root, '.tau', workersPath, reviewName(root, directory));

export const checkReviewDirectory = async (root: string, directory: string): Promise<string> => {
  const name = reviewName(root, directory);
  const path = join(root, '.tau', workersPath, name);

  await checkTauDirectory(root, `${workersPath}/${name}`);

  const entry = await existingEntry(path);

  if (entry?.isDirectory() !== true) {
    throw new Error(`The review directory ${path} does not exist. Run prepare first.`);
  }

  // The capture folder comes before its artifacts, so a linked folder is refused before an lstat
  // follows it.
  const files = [
    inputFileName,
    recordFileName,
    recheckFileName,
    generationFolderName,
    join(generationFolderName, generationPatchFileName),
    join(generationFolderName, generationInputFileName),
  ];

  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop -- a few lstat calls; order keeps the first error stable.
    await rejectLinkedFile(join(path, file), 'write');
  }

  return path;
};
