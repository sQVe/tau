import { randomUUID } from 'node:crypto';
import { lstat, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { isMissingFile } from '../../errors.js';

const isSymlink = async (path: string) => {
  try {
    const stats = await lstat(path);

    return stats.isSymbolicLink();
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }

    throw error;
  }
};

// Writes a new file and renames it over the target, so a failed write keeps the old file or no
// file. The rename replaces a link at the target instead of following it.
export const replaceFile = async (path: string, content: string): Promise<void> => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}`);

  if (await isSymlink(path)) {
    throw new Error(`Refusing to write through a symlink: ${path}`);
  }

  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });

    throw error;
  }
};
