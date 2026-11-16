import { dirname } from 'node:path';

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
