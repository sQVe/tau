import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import type { TestContext } from 'vitest';

import type { Exec } from '../src/command.js';
import { connect as connectToHc } from '../src/hc/connect.js';
import type { HcRuntime } from '../src/hc/hc.js';
import { isolationProblems } from './hcIsolation.js';
import type { ProtectedVariable } from './hcIsolation.js';

export interface HcSession {
  root: string;
  session: string;
  environment: Readonly<Record<string, string>>;
  runtime: HcRuntime;
  stop: () => Promise<void>;
}

export interface HcSessionOptions {
  session?: string;
}

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

export const sessionProcesses = (session: string): number[] => {
  const marker = `HC_SESSION=${session}`;
  const processIds = readdirSync('/proc').filter((name) => /^\d+$/.test(name));

  return processIds.filter((processId) => isLiveSessionProcess(processId, marker)).map(Number);
};

// hc server stop can return before the core process is gone. The core is not a child of this
// process, so no exit event exists, and the wait polls /proc.
const waitForSessionExit = async (session: string): Promise<void> => {
  const deadline = Date.now() + stopDeadlineMilliseconds;

  while (sessionProcesses(session).length > 0) {
    if (Date.now() > deadline) {
      throw new Error(`hc session ${session} still runs after hc server stop`);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, stopPollMilliseconds);
    });
  }
};

const createExec = (environment: Readonly<Record<string, string>>): Exec => {
  return (command, commandArguments, options = {}) =>
    new Promise((resolve, reject) => {
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

    let stopRequested = false;

    const stop = async (): Promise<void> => {
      if (stopRequested) {
        return;
      }

      stopRequested = true;

      let failure: unknown;

      try {
        const result = await exec('hc', ['server', 'stop', '--json'], { cwd: root });

        if (result.code !== 0 || result.killed) {
          failure = new Error(`hc server stop failed: ${result.stderr.trim()}`);
        } else {
          await waitForSessionExit(session);
        }
      } catch (error) {
        failure = error;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }

      if (failure !== undefined) {
        throw asError(failure);
      }
    };

    registerCleanup(stop);

    return { root, session, environment, runtime, stop };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });

    throw asError(error);
  }
};
