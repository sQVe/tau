import { dirname } from 'node:path';

import { readGit } from '../git.ts';

// Every worktree of a repository shares one Git common directory, so its parent names the project
// from a linked worktree, the bare root, and a plain checkout alike.
export const findProjectRoot = async (cwd: string): Promise<string> => {
  const commonDirectory = await readGit(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);

  return dirname(commonDirectory);
};
