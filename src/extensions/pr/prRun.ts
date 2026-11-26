import { join } from 'node:path';

import { readRegularFile } from '../../instructions/regularFile.js';
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

export const readRunFile = (path: string): Promise<Buffer> =>
  readRegularFile(path, {
    noFollow: true,
    notRegularMessage: `Refusing to read a path that is not a regular file: ${path}`,
    hardLinkMessage: `Refusing to read through a file with another hard link: ${path}`,
  });

// Resolves the run directory name after the ignore and link checks both readers share.
export const runName = async (root: string, directory: string, label: string): Promise<string> => {
  const name = requireTauChild(root, runPath, runPrefix, directory, label);

  await checkTauDirectory(root, `${runPath}/${name}`);

  return name;
};

export const runDirectoryPath = (root: string, name: string): string =>
  join(root, '.tau', runPath, name);
