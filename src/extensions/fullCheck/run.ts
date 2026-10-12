import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureTauDirectory } from '../../tauDirectory.js';
import { groupIsAlive } from './queue.js';

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

// Asks the command's process group to stop, and kills it if it ignores the request.
const stopGroup = (processId: number | undefined): NodeJS.Timeout | undefined => {
  if (processId === undefined) {
    return undefined;
  }

  try {
    process.kill(-processId, 'SIGTERM');
  } catch {
    return undefined;
  }

  return setTimeout(() => {
    try {
      process.kill(-processId, 'SIGKILL');
    } catch {
      // The group already exited.
    }
  }, killGraceMilliseconds);
};

const groupPollMilliseconds = 20;

// Escalates to SIGKILL after the grace period, and resolves when no process of the group is left.
const waitForGroupToExit = async (processId: number): Promise<void> => {
  const deadline = Date.now() + killGraceMilliseconds;
  let killed = false;

  while (groupIsAlive(processId)) {
    if (!killed && Date.now() >= deadline) {
      killed = true;

      try {
        process.kill(-processId, 'SIGKILL');
      } catch {
        // The group already exited.
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

  try {
    const [command = '', ...commandArguments] = argv;

    const status = await new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve, reject) => {
        // A process group leader, so a cancel reaches the processes the command starts.
        const child = spawn(command, commandArguments, {
          cwd: root,
          stdio: ['ignore', log.fd, log.fd],
          detached: true,
        });

        if (child.pid !== undefined) {
          onStarted(child.pid).catch(reject);
        }

        let killTimer: NodeJS.Timeout | undefined;

        const stop = () => {
          killTimer = stopGroup(child.pid);
        };

        child.once('error', reject);

        child.once('close', (exitCode, exitSignal) => {
          signal?.removeEventListener('abort', stop);

          if (signal?.aborted !== true) {
            resolve({ exitCode, signal: exitSignal });

            return;
          }

          // The launcher may exit on SIGTERM while a descendant in its group keeps running.
          const finishCancel = async () => {
            await waitForGroupToExit(child.pid ?? 0);
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

    const tail = await readTail(logPath);

    return { passed: status.exitCode === 0, ...status, logPath, tail };
  } finally {
    await log.close();
  }
};
