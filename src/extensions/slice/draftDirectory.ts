import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { isMissingFile } from '../../errors.js';
import { checkTauDirectory } from '../../tauDirectory.js';
import { rejectLinkedDraftFiles } from './draft.js';
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
  await rejectLinkedDraftFiles(directory);

  return directory;
};

export const draftName = (root: string, directory: string | undefined): string => {
  if (directory === undefined) {
    throw new Error('read and apply need the directory that prepare returned.');
  }

  const absolute = resolve(root, directory);
  const fromSlices = relative(join(root, '.tau', slicesPath), absolute);
  const outside = fromSlices === '' || fromSlices.startsWith('..') || isAbsolute(fromSlices);
  const nested = fromSlices.includes('/') || fromSlices.includes('\\');

  if (outside || nested) {
    throw new Error(`The draft directory must be .tau/slices/<id>, not ${directory}.`);
  }

  return fromSlices;
};
