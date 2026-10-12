import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureTauDirectory } from '../../tauDirectory.js';
import { commandIsAlive } from './queue.js';

export interface CheckResult {
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  logPath: string;
  tail: string;
}

const tailLineCount = 40;

export const readTail = async (logPath: string): Promise<string> => {
  const text = await readFile(logPath, 'utf8');

  return text.trimEnd().split('\n').slice(-tailLineCount).join('\n');
};

const newLogPath = async (root: string): Promise<string> => {
  const directory = await ensureTauDirectory(root, 'checks');
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');

  return join(directory, `${stamp}-${process.pid}.log`);
};

const killGraceMilliseconds = 5000;

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

// Escalates to SIGKILL after the grace period, and resolves when the command is gone.
const waitForCommandToExit = async (child: ChildProcess, processId: number): Promise<void> => {
  const deadline = Date.now() + killGraceMilliseconds;
  let killed = false;

  while (commandIsAlive(processId)) {
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
): Promise<CheckResult> => {
  const logPath = await newLogPath(root);
  const log = await open(logPath, 'wx');

  // Settles with the record's error, or undefined. The caller releases the lock only after this
  // settles, so the release never races the record's rewrite of the same lock file.
  let recorded: Promise<Error | undefined> = Promise.resolve(undefined);

  try {
    const [command = '', ...commandArguments] = argv;

    const status = await new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve, reject) => {
        // A process group leader, so a cancel reaches the processes the command starts.
        // Windows has no groups; a detached child there would only open a new console.
        const child = spawn(command, commandArguments, {
          cwd: root,
          stdio: ['ignore', log.fd, log.fd],
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

        const stop = () => {
          killTimer = stopCommand(child);
        };

        child.once('error', reject);

        child.once('close', (exitCode, exitSignal) => {
          signal?.removeEventListener('abort', stop);

          if (signal?.aborted !== true) {
            resolve({ exitCode, signal: exitSignal });

            return;
          }

          // A command that never spawned has no group, and the error event already settled the run.
          const { pid: processId } = child;

          if (processId === undefined) {
            return;
          }

          // The launcher may exit on SIGTERM while a descendant in its group keeps running.
          const finishCancel = async () => {
            await waitForCommandToExit(child, processId);
            clearTimeout(killTimer);
            reject(new Error('The full check was cancelled and its command has stopped.'));
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

    return { passed: status.exitCode === 0, ...status, logPath, tail };
  } finally {
    await recorded;
    await log.close();
  }
};
