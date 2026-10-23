import { spawn } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { groupState, stopGroup } from '../../process/process.js';
import { ensureTauDirectory } from '../../tauDirectory.js';
import { commandIsIdle } from './idleDecision.js';

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

export const stdoutPathOf = (logPath: string): string => logPath.replace(/\.log$/u, '.stdout');

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
  const stdoutPath = stdoutPathOf(logPath);
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

        let stopping: Promise<void> | undefined;

        const stop = () => {
          stopping ??= stopGroup(child, killGraceMilliseconds);
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

          const finishClose = async () => {
            if (signal?.aborted === true) {
              stop();
              await stopping;

              throw new Error('The check was cancelled and its command has stopped.');
            }

            if ((await groupState(processId)) !== 'gone') {
              stop();
            }

            await stopping;
            resolve({ exitCode, signal: exitSignal });
          };

          finishClose().catch((error: unknown) => {
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
