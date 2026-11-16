import { dirname } from 'node:path';

import { readGit } from '../git.ts';

export const findProjectRoot = async (cwd: string): Promise<string> => {
  const commonDirectory = await readGit(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);

  return dirname(commonDirectory);
};
