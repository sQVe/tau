import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ensureTauDirectory } from '../../tauDirectory.js';
import { groupHasRunningMember } from './groupMembers.js';
import { commandIsIdle } from './idleDecision.js';
import { commandIsAlive } from './queue.js';

export interface CheckResult {
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  idle: boolean;
  logPath: string;
  tail: string;
  // Set when stdout went to its own file, which holds the command's stdout and nothing else.
  stdoutPath?: string;
}

const tailLineCount = 40;

export const readTail = async (logPath: string): Promise<string> => {
  const text = await readFile(logPath, 'utf8');

  return text.trimEnd().split('\n').slice(-tailLineCount).join('\n');
};

const newLogPath = async (root: string, checksPath: string): Promise<string> => {
  const directory = await ensureTauDirectory(root, checksPath);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');

  return join(directory, `${stamp}-${process.pid}.log`);
};

const killGraceMilliseconds = 5000;

const millisecondsPerMinute = 60_000;
const idleLimitMinutes = 2;
const defaultIdleLimitMilliseconds = idleLimitMinutes * millisecondsPerMinute;
const idlePollCeilingMilliseconds = 1000;
const idlePollsPerLimit = 4;

// Windows has no process groups, so only the direct child can be signalled there.
const signalCommand = (child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void => {
  if (process.platform === 'win32') {
    child.kill(signal);

    return;
  }

  if (child.pid !== undefined) {
    process.kill(-child.pid, signal);
  }
};

// Asks the command to stop, and kills it if it ignores the request.
const stopCommand = (child: ChildProcess): NodeJS.Timeout | undefined => {
  if (child.pid === undefined) {
    return undefined;
  }

  try {
    signalCommand(child, 'SIGTERM');
  } catch {
    return undefined;
  }

  return setTimeout(() => {
    try {
      signalCommand(child, 'SIGKILL');
    } catch {
      // The command already exited.
    }
  }, killGraceMilliseconds);
};

const groupPollMilliseconds = 20;

// A zombie keeps the group visible to kill(-group, 0) and SIGKILL cannot remove it, so after the
// SIGKILL only a running member counts. When ps fails the group counts as gone: the SIGKILL was
// sent, and waiting on an unreadable process table could hold the lock forever.
const groupHasRunningProcess = async (groupId: number): Promise<boolean> => {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pgid=,stat=']);

    return groupHasRunningMember(stdout, groupId);
  } catch {
    return false;
  }
};

// Escalates to SIGKILL after the grace period, and resolves when the command is gone.
const waitForCommandToExit = async (child: ChildProcess, processId: number): Promise<void> => {
  const deadline = Date.now() + killGraceMilliseconds;
  let killed = false;

  while (commandIsAlive(processId)) {
    // oxlint-disable-next-line no-await-in-loop -- Each poll depends on the previous one.
    if (killed && !(await groupHasRunningProcess(processId))) {
      return;
    }

    if (!killed && Date.now() >= deadline) {
      killed = true;

      try {
        signalCommand(child, 'SIGKILL');
      } catch {
        // The command already exited.
      }
    }

    // oxlint-disable-next-line no-await-in-loop -- Each poll depends on the previous one.
    await new Promise((resolve) => {
      setTimeout(resolve, groupPollMilliseconds);
    });
  }
};

// Runs argv without a shell in `root`, with stdout and stderr together in a new log file.
export const runCheck = async (
  root: string,
  argv: string[],
  signal: AbortSignal | undefined,
  onStarted: (groupId: number) => Promise<void>,
  idleLimitMilliseconds = defaultIdleLimitMilliseconds,
  separateStdout = false,
  checksPath = 'checks',
): Promise<CheckResult> => {
  const logPath = await newLogPath(root, checksPath);
  const log = await open(logPath, 'wx');
  const stdoutPath = logPath.replace(/\.log$/u, '.stdout');
  const stdoutFile = separateStdout ? await open(stdoutPath, 'wx') : undefined;

  // Settles with the record's error, or undefined. The caller releases the lock only after this
  // settles, so the release never races the record's rewrite of the same lock file.
  let recorded: Promise<Error | undefined> = Promise.resolve(undefined);

  const hang = { idle: false };
  let idleMonitor: NodeJS.Timeout | undefined;

  try {
    const [command = '', ...commandArguments] = argv;

    const status = await new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve, reject) => {
        // A process group leader, so a cancel reaches the processes the command starts.
        // Windows has no groups; a detached child there would only open a new console.
        const child = spawn(command, commandArguments, {
          cwd: root,
          stdio: ['ignore', stdoutFile?.fd ?? log.fd, log.fd],
          detached: process.platform !== 'win32',
        });

        if (child.pid !== undefined) {
          recorded = onStarted(child.pid).then(
            () => undefined,
            (error: unknown) =>
              error instanceof Error
                ? error
                : new Error('Could not record the command group in the lock.', { cause: error }),
          );
        }

        let killTimer: NodeJS.Timeout | undefined;

        let stopped = false;

        const stop = () => {
          if (stopped) {
            return;
          }

          stopped = true;
          killTimer = stopCommand(child);
        };

        let lastSize = 0;
        let lastOutputAt = Date.now();

        // A command that writes nothing for the idle limit is hung. Stopping it releases the lock.
        idleMonitor = setInterval(
          () => {
            const { size } = fstatSync(log.fd);
            const now = Date.now();

            if (size !== lastSize) {
              lastSize = size;
              lastOutputAt = now;

              return;
            }

            if (commandIsIdle({ now, lastOutputAt, idleLimitMilliseconds })) {
              clearInterval(idleMonitor);
              hang.idle = true;
              stop();
            }
          },
          Math.min(idlePollCeilingMilliseconds, idleLimitMilliseconds / idlePollsPerLimit),
        );

        child.once('error', (error) => {
          clearTimeout(killTimer);
          reject(error);
        });

        child.once('close', (exitCode, exitSignal) => {
          clearInterval(idleMonitor);
          signal?.removeEventListener('abort', stop);

          // A command that never spawned has no group, and the error event already settled the run.
          const { pid: processId } = child;

          if (processId === undefined) {
            return;
          }

          if (signal?.aborted !== true) {
            // Background processes may outlive the direct child, and the lock must not be released
            // while they run. Windows has no group to probe.
            const groupRemains = process.platform !== 'win32' && commandIsAlive(processId);

            if (!groupRemains) {
              clearTimeout(killTimer);
              resolve({ exitCode, signal: exitSignal });

              return;
            }

            stop();

            const finishExit = async () => {
              await waitForCommandToExit(child, processId);
              clearTimeout(killTimer);
              resolve({ exitCode, signal: exitSignal });
            };

            finishExit().catch((error: unknown) => {
              reject(error instanceof Error ? error : new Error(String(error)));
            });

            return;
          }

          // The launcher may exit on SIGTERM while a descendant in its group keeps running.
          const finishCancel = async () => {
            await waitForCommandToExit(child, processId);
            clearTimeout(killTimer);
            reject(new Error('The check was cancelled and its command has stopped.'));
          };

          finishCancel().catch((error: unknown) => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        });

        if (signal?.aborted === true) {
          stop();
        } else {
          signal?.addEventListener('abort', stop, { once: true });
        }
      },
    );

    const recordError = await recorded;

    if (recordError !== undefined) {
      throw recordError;
    }

    const tail = await readTail(logPath);

    return {
      passed: !hang.idle && status.exitCode === 0,
      ...status,
      idle: hang.idle,
      logPath,
      tail,
      ...(separateStdout ? { stdoutPath } : {}),
    };
  } finally {
    clearInterval(idleMonitor);
    await recorded;
    await log.close();
    await stdoutFile?.close();
  }
};
