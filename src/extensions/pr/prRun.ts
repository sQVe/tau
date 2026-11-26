import { join } from 'node:path';

import { checkTauDirectory, requireTauChild } from '../../tauDirectory.js';

export const runPath = 'pr';
export const runPrefix = 'run-';

export const titleFileName = 'title.md';
export const bodyFileName = 'body.md';
export const reviewFileName = 'review.json';

// Resolves the run directory name after the ignore and link checks both readers share.
export const runName = async (root: string, directory: string, label: string): Promise<string> => {
  const name = requireTauChild(root, runPath, runPrefix, directory, label);

  await checkTauDirectory(root, `${runPath}/${name}`);

  return name;
};

export const runDirectoryPath = (root: string, name: string): string =>
  join(root, '.tau', runPath, name);
