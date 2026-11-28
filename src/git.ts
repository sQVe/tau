import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import type { ChildProcess, ExecFileException } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

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

export type ProbeCache<Value> = Map<string, Promise<Value>>;

export type BareProbe = { status: 'read'; bare: boolean } | { status: 'failed' };

type TimeoutTimers = Partial<Record<'kill' | 'confirm', ReturnType<typeof setTimeout>>>;

const scopedEnvironment = new AsyncLocalStorage<Record<string, string>>();

export const createProbeCache = <Value>(): ProbeCache<Value> => new Map();

// Shares one in-flight probe per key within the cache's scope. Drops an entry whose result the
// keep test rejects, so the next call asks again.
export const readProbe = async <Value>(
  cache: ProbeCache<Value>,
  key: string,
  probe: () => Promise<Value>,
  keep: (value: Value) => boolean,
): Promise<Value> => {
  const cached = cache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const read = probe();

  cache.set(key, read);

  const value = await read;

  if (!keep(value) && cache.get(key) === read) {
    cache.delete(key);
  }

  return value;
};

export const withGitEnvironment = <Value>(
  environment: Record<string, string>,
  run: () => Promise<Value>,
): Promise<Value> => scopedEnvironment.run(environment, run);

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
const killGraceMilliseconds = 5000;
const killConfirmMilliseconds = 2000;

const startTimeoutKill = (
  timers: TimeoutTimers,
  child: ChildProcess,
  timeoutMilliseconds: number,
  onTimeout: () => void,
  onFinal: (killSent: boolean) => void,
): void => {
  if (timeoutMilliseconds <= 0) {
    return;
  }

  timers.kill = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    onTimeout();

    timers.confirm = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      let killSent = false;

      timers.confirm = setTimeout(() => {
        onFinal(killSent);
      }, killConfirmMilliseconds);

      killSent = child.kill('SIGKILL');
    }, killGraceMilliseconds);

    child.kill('SIGTERM');
  }, timeoutMilliseconds);
};

const unfinished = (reason: string): GitResult => ({
  exitCode: null,
  stdout: Buffer.alloc(0),
  stderr: reason,
});

const stoppedByLimit = (error: ExecFileException | null): boolean =>
  error?.code === 'ABORT_ERR' || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

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

    let stopDraining: (() => void) | undefined;
    let gitChild: ChildProcess | undefined;
    const timers: TimeoutTimers = {};
    let timedOut = false;
    let settled = false;

    const clearTimers = () => {
      clearTimeout(timers.kill);
      clearTimeout(timers.confirm);
    };

    const finish = (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => {
      if (settled) {
        return;
      }

      settled = true;
      stopDraining?.();
      clearTimers();

      const stdoutBytes = Buffer.from(stdout);
      const stderrText = Buffer.from(stderr).toString('utf8');

      if (error === null && !timedOut) {
        resolve({ exitCode: 0, stdout: stdoutBytes, stderr: stderrText });

        return;
      }

      if (error !== null && typeof error.code === 'number' && !timedOut) {
        resolve({ exitCode: error.code, stdout: stdoutBytes, stderr: stderrText });

        return;
      }

      const reason =
        timedOut && !stoppedByLimit(error)
          ? `git ${commandArguments.join(' ')} timed out after ${timeoutMilliseconds} ms`
          : (error?.message ?? 'git was killed');

      resolve({ exitCode: null, stdout: stdoutBytes, stderr: `${stderrText}${reason}` });
    };

    const finishAfterKill = (killSent: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      stopDraining?.();
      clearTimers();

      gitChild?.stdout?.destroy();
      gitChild?.stderr?.destroy();

      const clause = killSent ? ' and did not exit after SIGKILL' : ' and could not be stopped';
      const reason = `git ${commandArguments.join(' ')} timed out after ${timeoutMilliseconds} ms${clause}`;

      resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: reason });
    };

    try {
      if (timeoutMilliseconds !== null && timeoutMilliseconds < 0) {
        throw new RangeError(
          `The Git timeout must not be negative. Received ${timeoutMilliseconds}`,
        );
      }

      gitChild = execFile(
        'git',
        commandArguments,
        {
          cwd,
          env: { ...gitEnvironment(), ...scopedEnvironment.getStore(), ...environment },
          encoding: 'buffer',
          maxBuffer: maxOutputBytes,
          ...(signal === undefined ? {} : { signal }),
        },
        finish,
      );

      stopDraining = drainAfterExit(gitChild);

      gitChild.stdin?.on('error', () => undefined);

      if (input !== undefined) {
        gitChild.stdin?.end(input);
      }

      if (timeoutMilliseconds !== null) {
        startTimeoutKill(
          timers,
          gitChild,
          timeoutMilliseconds,
          () => {
            timedOut = true;
          },
          finishAfterKill,
        );
      }
    } catch (error) {
      settled = true;
      stopDraining?.();
      clearTimers();

      const errorMessage = error instanceof Error ? error.message : String(error);

      resolve(unfinished(errorMessage));
    }
  });

const gitFailure = (commandArguments: string[], result: GitResult): Error =>
  new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);

export const readGit = async (
  cwd: string,
  commandArguments: string[],
  options: GitOptions = {},
): Promise<string> => {
  const result = await runGit(cwd, commandArguments, options);

  if (result.exitCode !== 0) {
    throw gitFailure(commandArguments, result);
  }

  return result.stdout.toString('utf8').trim();
};

export const readGitUnlessMissing = async (
  cwd: string,
  commandArguments: string[],
  options: GitOptions = {},
): Promise<string | undefined> => {
  const result = await runGit(cwd, commandArguments, options);

  if (result.exitCode === 1) {
    return undefined;
  }

  if (result.exitCode !== 0) {
    throw gitFailure(commandArguments, result);
  }

  return result.stdout.toString('utf8').trim();
};

export const findCheckoutRoot = async (
  cwd: string,
  toolName: string,
  options: GitOptions = {},
): Promise<string> => {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], {
    timeoutMilliseconds: 5000,
    ...options,
  });

  const root = result.exitCode === 0 ? result.stdout.toString('utf8').trim() : '';

  if (root === '') {
    throw new Error(`The ${toolName} tool needs a Git checkout, and ${cwd} is not in one.`);
  }

  return root;
};

const operationProbeCaches = new AsyncLocalStorage<Map<string, unknown>>();

// A read or write keeps one answer per named probe across its nested checks. Outside such an
// operation, each call asks Git again so a changed repository takes effect at once.
export const withOperationProbes = <Value>(run: () => Promise<Value>): Promise<Value> =>
  operationProbeCaches.run(new Map(), run);

export const operationProbeCache = <Value>(name: string): ProbeCache<Value> => {
  const caches = operationProbeCaches.getStore();

  if (caches === undefined) {
    return createProbeCache();
  }

  const cached = caches.get(name);

  if (cached !== undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Each probe name is read with one value type at every call site.
    return cached as ProbeCache<Value>;
  }

  const created = createProbeCache<Value>();

  caches.set(name, created);

  return created;
};

export const currentBareProbeCache = (): ProbeCache<BareProbe> => operationProbeCache('bare');

const probeBareRoot = async (root: string): Promise<BareProbe> => {
  const result = await runGit(root, ['rev-parse', '--is-bare-repository'], {
    timeoutMilliseconds: 5000,
  });

  if (result.exitCode !== 0) {
    return { status: 'failed' };
  }

  return { status: 'read', bare: result.stdout.toString('utf8').trim() === 'true' };
};

export const isBareRoot = async (
  root: string,
  cache: ProbeCache<BareProbe> = currentBareProbeCache(),
): Promise<boolean> => {
  const read = await readProbe(
    cache,
    root,
    () => probeBareRoot(root),
    (result) => result.status === 'read',
  );

  return read.status === 'read' && read.bare;
};

const hasGitEntry = (root: string): Promise<boolean> =>
  lstat(join(root, '.git')).then(
    () => true,
    () => false,
  );

// A `.git` entry can name a path Git cannot resolve, so a folder counts as a checkout only when
// Git resolves a repository there.
export const isGitRepository = async (folder: string): Promise<boolean> => {
  const commandArguments = ['rev-parse', '--git-dir'];
  const result = await runGit(folder, commandArguments, { timeoutMilliseconds: 5000 });

  if (result.exitCode === null) {
    throw gitFailure(commandArguments, result);
  }

  return result.exitCode === 0;
};

// A `.git` entry means a checkout, so its presence answers without a Git call.
export const isBareRootWithoutGitEntry = async (root: string): Promise<boolean> =>
  !(await hasGitEntry(root)) && isBareRoot(root);
