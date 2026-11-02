import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import type { TestContext } from 'vitest';

import type { Exec } from '../src/command.js';
import { connect as connectToHc } from '../src/hc/connect.js';
import type { HcRuntime } from '../src/hc/hc.js';
import { isAbortError } from '../src/hc/replies.js';
import { isolationProblems } from './hcIsolationHarness.js';
import type { ProtectedVariable } from './hcIsolationHarness.js';

export interface HcSession {
  root: string;
  session: string;
  environment: Readonly<Record<string, string>>;
  runtime: HcRuntime;
  stop: () => Promise<void>;
}

export interface HcSessionOptions {
  session?: string;
  listProcesses?: (session: string) => number[];
}

type SessionProcessLister = (session: string) => number[];

type HarnessExecResult = Awaited<ReturnType<Exec>> & { signal?: NodeJS.Signals | undefined };

export const inheritedVariables = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ'] as const;

const resolvePath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const resolveExisting = (path: string | undefined): string | undefined =>
  path === undefined || path === '' ? path : resolvePath(path);

const realValues = (): Record<ProtectedVariable, string | undefined> => ({
  HOME: resolveExisting(homedir()),
  XDG_RUNTIME_DIR: resolveExisting(
    process.env['XDG_RUNTIME_DIR'] ?? `/run/user/${String(userInfo().uid)}`,
  ),
  XDG_STATE_HOME: resolveExisting(process.env['XDG_STATE_HOME']),
  XDG_CONFIG_HOME: resolveExisting(process.env['XDG_CONFIG_HOME']),
  XDG_DATA_HOME: resolveExisting(process.env['XDG_DATA_HOME']),
  XDG_CACHE_HOME: resolveExisting(process.env['XDG_CACHE_HOME']),
});

const privateEnvironment = (root: string, session: string): Record<string, string> => {
  const environment: Record<string, string> = {};

  for (const name of inheritedVariables) {
    const value = process.env[name];

    if (value !== undefined) {
      environment[name] = value;
    }
  }

  environment['HOME'] = join(root, 'home');
  environment['XDG_RUNTIME_DIR'] = join(root, 'run');
  environment['XDG_STATE_HOME'] = join(root, 'state');
  environment['XDG_CONFIG_HOME'] = join(root, 'config');
  environment['XDG_DATA_HOME'] = join(root, 'data');
  environment['XDG_CACHE_HOME'] = join(root, 'cache');
  environment['HC_SESSION'] = session;

  return environment;
};

const createDirectories = (root: string): void => {
  for (const folder of ['home', 'run', 'state', 'config', 'data', 'cache']) {
    mkdirSync(join(root, folder), { recursive: true });
  }
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const stopDeadlineMilliseconds = 5000;

const stopPollMilliseconds = 20;

// A zombie has exited and holds no socket or file, so it does not count.
const isLiveSessionProcess = (processId: string, marker: string): boolean => {
  try {
    const status = readFileSync(`/proc/${processId}/stat`, 'utf8');
    const state = status.charAt(status.lastIndexOf(')') + 2);
    const environment = readFileSync(`/proc/${processId}/environ`, 'utf8').split('\0');

    return state !== 'Z' && environment.includes(marker);
  } catch {
    return false;
  }
};

// Reads /proc, which exists only on Linux. Other platforms report no session process.
export const sessionProcesses = (session: string): number[] => {
  if (process.platform !== 'linux') {
    return [];
  }

  const marker = `HC_SESSION=${session}`;
  const processIds = readdirSync('/proc').filter((name) => /^\d+$/.test(name));

  return processIds.filter((processId) => isLiveSessionProcess(processId, marker)).map(Number);
};

// hc server stop can return before the core process is gone. The core is not a child of this
// process, so no exit event exists, and the wait polls /proc. Returns false at the deadline.
const waitForSessionExit = async (
  session: string,
  listProcesses: SessionProcessLister,
): Promise<boolean> => {
  const deadline = Date.now() + stopDeadlineMilliseconds;

  while (listProcesses(session).length > 0) {
    if (Date.now() > deadline) {
      return false;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, stopPollMilliseconds);
    });
  }

  return true;
};

// Only the stop request ends a session. The fixture never signals a process by PID, because a PID
// read from /proc can be reused by another process before a signal reaches it.
const stopCore = async (
  exec: Exec,
  session: string,
  root: string,
  listProcesses: SessionProcessLister,
): Promise<void> => {
  const result = await exec('hc', ['server', 'stop', '--json'], {
    cwd: root,
    timeout: stopDeadlineMilliseconds,
  });

  if (result.code !== 0 || result.killed) {
    throw new Error(`hc server stop failed: ${result.stderr.trim()}`);
  }

  if (!(await waitForSessionExit(session, listProcesses))) {
    throw new Error(`hc session ${session} still runs after hc server stop`);
  }
};

// Removes the root only when no session process remains. Otherwise the root is kept, and the error
// names the session and the root and carries the first failure as its cause.
const stopSession = async (
  exec: Exec,
  session: string,
  root: string,
  listProcesses: SessionProcessLister,
): Promise<void> => {
  let failure: unknown;

  try {
    await stopCore(exec, session, root, listProcesses);
  } catch (error) {
    failure = error;
  }

  if (listProcesses(session).length > 0) {
    throw new Error(`hc session ${session} still has processes after stop; kept ${root}`, {
      cause: failure,
    });
  }

  rmSync(root, { recursive: true, force: true });

  if (failure !== undefined) {
    throw asError(failure);
  }
};

const killedResult = (
  error: ExecFileException,
  stdout: string,
  stderr: string,
): HarnessExecResult => ({
  code: typeof error.code === 'number' ? error.code : 1,
  killed: true,
  stdout,
  stderr,
  signal: error.signal,
});

const createExec = (environment: Readonly<Record<string, string>>): Exec => {
  return (command, commandArguments, options = {}) =>
    new Promise<HarnessExecResult>((resolve, reject) => {
      execFile(
        command,
        commandArguments,
        {
          env: environment,
          encoding: 'utf8',
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, killed: false, stdout, stderr });

            return;
          }

          if (isAbortError(error)) {
            reject(asError(error));

            return;
          }

          if (error.killed === true) {
            resolve(killedResult(error, stdout, stderr));

            return;
          }

          if (typeof error.code !== 'number') {
            reject(asError(error));

            return;
          }

          resolve({ code: error.code, killed: false, stdout, stderr });
        },
      );
    });
};

export const startHcSession = async (
  registerCleanup: TestContext['onTestFinished'],
  options: HcSessionOptions = {},
): Promise<HcSession> => {
  const session = (options.session ?? `tau-test-${randomBytes(6).toString('hex')}`).trim();
  const root = resolvePath(mkdtempSync(join(tmpdir(), 'tau-hc-')));

  try {
    createDirectories(root);

    const environment = privateEnvironment(root, session);

    const problems = isolationProblems({
      session,
      inheritedSession: process.env['HC_SESSION'],
      values: environment,
      realValues: realValues(),
      variables: Object.keys(environment),
    });

    if (problems.length > 0) {
      throw new Error(`refusing to start hc in a shared session: ${problems.join('; ')}`);
    }

    const exec = createExec(environment);

    const runtime: HcRuntime = {
      exec,
      connect: (lines, connectOptions = {}) =>
        connectToHc(lines, { ...connectOptions, env: environment }),
      cwd: root,
    };

    const listProcesses = options.listProcesses ?? sessionProcesses;

    let stopping: Promise<void> | undefined;

    const stop = (): Promise<void> => {
      stopping ??= stopSession(exec, session, root, listProcesses);

      return stopping;
    };

    registerCleanup(stop);

    return { root, session, environment, runtime, stop };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });

    throw asError(error);
  }
};
