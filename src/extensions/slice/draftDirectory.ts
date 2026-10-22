import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from '../../errors.js';
import { checkTauDirectory, rejectLinkedEntries, requireTauChild } from '../../tauDirectory.js';
import { slicesPath } from './state.js';

const isMissing = (path: string) =>
  lstat(path).then(
    () => false,
    (error: unknown) => {
      if (isMissingFile(error)) {
        return true;
      }

      throw error;
    },
  );

// Runs the same refusals as createDraftDirectory without changing anything. A missing draft has
// nothing to check: read reports no draft, and apply refuses it.
export const checkDraftDirectory = async (
  root: string,
  name: string,
  action: 'read' | 'apply',
): Promise<string> => {
  const directory = join(root, '.tau', slicesPath, name);

  if (await isMissing(directory)) {
    if (action === 'apply') {
      throw new Error(`The draft directory ${directory} does not exist. Nothing was written.`);
    }

    return directory;
  }

  await checkTauDirectory(root, `${slicesPath}/${name}`);
  await rejectLinkedEntries(directory);

  return directory;
};

export const draftName = (root: string, directory: string | undefined): string => {
  if (directory === undefined) {
    throw new Error('read and apply need the directory that prepare returned.');
  }

  return requireTauChild(root, slicesPath, '', directory, 'The draft directory');
};
