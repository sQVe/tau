import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { git } from './gitRepository.js';

export interface RepositorySnapshot {
  files: Record<string, string>;
  refs: string;
  index: string;
  objects: string;
}

const listFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();
};

const hashOf = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export const repositorySnapshot = async (
  root: string,
  directories: string[],
): Promise<RepositorySnapshot> => {
  const files = (await Promise.all(directories.map(listFiles))).flat();

  const entries = await Promise.all(
    files.map(async (file): Promise<[string, string]> => [file, hashOf(await readFile(file))]),
  );

  return {
    files: Object.fromEntries(entries),
    refs: await git(root, 'for-each-ref'),
    index: hashOf(await readFile(join(root, '.git', 'index'))),
    objects: await git(root, 'count-objects', '-v'),
  };
};
