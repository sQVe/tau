import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Runs Git on the repository at cwd. An inherited repository selector would make Git read that
// repository instead, so the selectors are removed. Resolves undefined when Git fails or runs past
// the timeout, since callers such as session start wait for it.
export const readGitOutput = async (
  cwd: string,
  commandArguments: string[],
  timeoutMilliseconds = 5000,
): Promise<string | undefined> => {
  // oxlint-disable-next-line node/no-process-env -- Git inherits the user's environment apart from the repository selectors.
  const inherited = process.env;

  const {
    GIT_DIR: _gitDirectory,
    GIT_WORK_TREE: _gitWorkTree,
    GIT_COMMON_DIR: _gitCommonDirectory,
    ...env
  } = inherited;

  try {
    const { stdout } = await promisify(execFile)('git', commandArguments, {
      cwd,
      env,
      timeout: timeoutMilliseconds,
    });

    return stdout;
  } catch {
    return undefined;
  }
};
