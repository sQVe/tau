import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { checkTauDirectory, requireTauChild } from '../../tauDirectory.js';

export const runPath = 'pr';
export const runPrefix = 'run-';

export const titleFileName = 'title.md';
export const bodyFileName = 'body.md';
export const reviewFileName = 'review.json';

export const requireValue = <ValueType>(
  action: string,
  name: string,
  value: ValueType | undefined,
): ValueType => {
  if (value === undefined) {
    throw new Error(`${action} needs ${name}.`);
  }

  return value;
};

// A pipe opens without a writer only in non-blocking mode. The type check and the read use one
// handle, and O_NOFOLLOW refuses a symlink swapped in after a path check.
export const readRunFile = async (path: string): Promise<Buffer> => {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const handle = await open(path, flags);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error(`Refusing to read a path that is not a regular file: ${path}`);
    }

    if (stats.nlink > 1) {
      throw new Error(`Refusing to read through a file with another hard link: ${path}`);
    }

    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

// Resolves the run directory name after the ignore and link checks both readers share.
export const runName = async (root: string, directory: string, label: string): Promise<string> => {
  const name = requireTauChild(root, runPath, runPrefix, directory, label);

  await checkTauDirectory(root, `${runPath}/${name}`);

  return name;
};

export const runDirectoryPath = (root: string, name: string): string =>
  join(root, '.tau', runPath, name);
