import { execFile } from 'node:child_process';
import type { ChildProcess, ExecFileException } from 'node:child_process';

export interface GitResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface GitOptions {
  timeoutMilliseconds?: number | null;
  input?: string;
  signal?: AbortSignal;
  environment?: Record<string, string>;
}

export const gitEnvironment = (): NodeJS.ProcessEnv => {
  // oxlint-disable-next-line node/no-process-env -- Git inherits the user's environment apart from repository, index, and object-store selectors.
  const inherited = process.env;

  const {
    GIT_DIR: _gitDirectory,
    GIT_WORK_TREE: _gitWorkTree,
    GIT_COMMON_DIR: _gitCommonDirectory,
    GIT_INDEX_FILE: _gitIndexFile,
    GIT_OBJECT_DIRECTORY: _gitObjectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: _gitAlternateObjectDirectories,
    LANGUAGE: _language,
    ...env
  } = inherited;

  return { ...env, LC_ALL: 'C' };
};

const maxOutputBytes = 1_073_741_824;

const defaultTimeoutMilliseconds = 60_000;
const outputIdleMilliseconds = 100;

const killedByTimeout = (
  child: ChildProcess | undefined,
  error: ExecFileException | null,
  options: GitOptions,
): boolean => {
  const aborted = options.signal?.aborted === true;
  const overflowed = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  const hasTimeout = options.timeoutMilliseconds !== null;
  const stoppedByLimit = aborted || overflowed;

  return child?.killed === true && hasTimeout && !stoppedByLimit;
};

const unfinished = (reason: string): GitResult => ({
  exitCode: null,
  stdout: Buffer.alloc(0),
  stderr: reason,
});

const drainAfterExit = (child: ChildProcess): (() => void) => {
  const streams = [child.stdout, child.stderr];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const waitForIdle = () => {
    clearTimeout(timer);

    timer = setTimeout(() => {
      for (const stream of streams) {
        stream?.destroy();
      }
    }, outputIdleMilliseconds);
  };

  const exited = () => {
    for (const stream of streams) {
      stream?.on('data', waitForIdle);
    }

    waitForIdle();
  };

  child.once('exit', exited);

  return () => {
    clearTimeout(timer);
    child.off('exit', exited);

    for (const stream of streams) {
      stream?.off('data', waitForIdle);
    }
  };
};

// Runs Git on the repository at cwd and always resolves, so a caller can accept a nonzero exit.
// Git prints its messages in English, so a caller can match them. When Git cannot start, is killed,
// prints more than 1 GiB, runs past the timeout, or is aborted, the exit code is null and stderr
// holds the reason.
export const runGit = (
  cwd: string,
  commandArguments: string[],
  options: GitOptions = {},
): Promise<GitResult> =>
  new Promise((resolve) => {
    const {
      timeoutMilliseconds = defaultTimeoutMilliseconds,
      input,
      signal,
      environment,
    } = options;

    let child: ChildProcess | undefined;
    let stopDraining: (() => void) | undefined;

    const finish = (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => {
      stopDraining?.();

      const stdoutBytes = Buffer.from(stdout);
      const stderrText = Buffer.from(stderr).toString('utf8');

      const timedOut = killedByTimeout(child, error, options);

      if (error === null && !timedOut) {
        resolve({ exitCode: 0, stdout: stdoutBytes, stderr: stderrText });

        return;
      }

      if (error !== null && typeof error.code === 'number' && !timedOut) {
        resolve({ exitCode: error.code, stdout: stdoutBytes, stderr: stderrText });

        return;
      }

      const reason = timedOut
        ? `git ${commandArguments.join(' ')} timed out after ${timeoutMilliseconds} ms`
        : (error?.message ?? 'git was killed');

      resolve({ exitCode: null, stdout: stdoutBytes, stderr: `${stderrText}${reason}` });
    };

    try {
      child = execFile(
        'git',
        commandArguments,
        {
          cwd,
          env: { ...gitEnvironment(), ...environment },
          timeout: timeoutMilliseconds ?? 0,
          encoding: 'buffer',
          maxBuffer: maxOutputBytes,
          ...(signal === undefined ? {} : { signal }),
        },
        finish,
      );

      stopDraining = drainAfterExit(child);

      child.stdin?.on('error', () => undefined);

      if (input !== undefined) {
        child.stdin?.end(input);
      }
    } catch (error) {
      stopDraining?.();
      resolve(unfinished(error instanceof Error ? error.message : String(error)));
    }
  });

export const readGit = async (
  cwd: string,
  commandArguments: string[],
  options: GitOptions = {},
): Promise<string> => {
  const result = await runGit(cwd, commandArguments, options);

  if (result.exitCode !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.stdout.toString('utf8').trim();
};

export const findCheckoutRoot = async (cwd: string, toolName: string): Promise<string> => {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], {
    timeoutMilliseconds: 5000,
  });

  const root = result.exitCode === 0 ? result.stdout.toString('utf8').trim() : '';

  if (root === '') {
    throw new Error(`The ${toolName} tool needs a Git checkout, and ${cwd} is not in one.`);
  }

  return root;
};
