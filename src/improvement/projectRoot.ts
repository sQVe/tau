import { dirname } from 'node:path';

import { errorMessage } from '../errors.ts';
import { readGit } from '../git.ts';
import type { GitOptions } from '../git.ts';

export const findProjectRoot = async (
  cwd: string,
  options: Pick<GitOptions, 'signal'> = {},
): Promise<string> => {
  const commonDirectory = await readGit(
    cwd,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    options,
  );

  return dirname(commonDirectory);
};

export const projectRootsOf = (indexed: readonly string[], current: string | null): string[] =>
  [...new Set(current === null ? indexed : [...indexed, current])].toSorted();

const isNotARepository = (message: string) => message.includes('not a git repository');

export const findOptionalProjectRoot = async (cwd: string): Promise<string | null> => {
  try {
    return await findProjectRoot(cwd);
  } catch (error) {
    if (isNotARepository(errorMessage(error))) {
      return null;
    }

    throw error;
  }
};
