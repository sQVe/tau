import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

// An inherited repository selector would make Git read that repository instead of the one at cwd.
const gitEnvironment = () => {
  // oxlint-disable-next-line node/no-process-env -- Git inherits the user's environment apart from the repository selectors.
  const inherited = process.env;

  const {
    GIT_DIR: _gitDirectory,
    GIT_WORK_TREE: _gitWorkTree,
    GIT_COMMON_DIR: _gitCommonDirectory,
    ...env
  } = inherited;

  return env;
};

// Runs Git on the repository at cwd. Resolves undefined when Git fails or runs past the timeout,
// since callers such as session start wait for it.
export const readGitOutput = async (
  cwd: string,
  commandArguments: string[],
  timeoutMilliseconds = 5000,
): Promise<string | undefined> => {
  try {
    const { stdout } = await promisify(execFile)('git', commandArguments, {
      cwd,
      env: gitEnvironment(),
      timeout: timeoutMilliseconds,
    });

    return stdout;
  } catch {
    return undefined;
  }
};

// 1 GiB.
const maxOutputBytes = 1_073_741_824;

// Runs Git on the repository at cwd and resolves its exit code with the raw output, so a caller can
// accept a nonzero exit. Git prints its messages in English, so a caller can match them. Rejects
// when Git cannot start, prints more than 1 GiB, or runs past the timeout.
export const runGit = (
  cwd: string,
  commandArguments: string[],
  timeoutMilliseconds = 60_000,
): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    const { LANGUAGE: _language, ...env } = gitEnvironment();

    const options = {
      cwd,
      env: { ...env, LC_ALL: 'C' },
      timeout: timeoutMilliseconds,
      encoding: 'buffer' as const,
      maxBuffer: maxOutputBytes,
    };

    execFile('git', commandArguments, options, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : error.code;

      if (typeof exitCode !== 'number') {
        reject(error ?? new Error(`git ${commandArguments.join(' ')} did not exit`));

        return;
      }

      resolve({ exitCode, stdout, stderr: stderr.toString('utf8') });
    });
  });
