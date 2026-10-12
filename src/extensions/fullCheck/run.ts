import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureTauDirectory } from '../../tauDirectory.js';

export interface CheckResult {
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  logPath: string;
  tail: string;
}

const tailLineCount = 40;

const readTail = async (logPath: string): Promise<string> => {
  const text = await readFile(logPath, 'utf8');

  return text.trimEnd().split('\n').slice(-tailLineCount).join('\n');
};

const newLogPath = async (root: string): Promise<string> => {
  const directory = await ensureTauDirectory(root, 'checks');
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');

  return join(directory, `${stamp}-${process.pid}.log`);
};

// Runs argv without a shell in `root`, with stdout and stderr together in a new log file.
export const runCheck = async (
  root: string,
  argv: string[],
  signal: AbortSignal | undefined,
): Promise<CheckResult> => {
  const logPath = await newLogPath(root);
  const log = await open(logPath, 'wx');

  try {
    const [command = '', ...commandArguments] = argv;

    const status = await new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve, reject) => {
        const child = spawn(command, commandArguments, {
          cwd: root,
          stdio: ['ignore', log.fd, log.fd],
          ...(signal === undefined ? {} : { signal }),
        });

        child.once('error', reject);

        child.once('close', (exitCode, exitSignal) => {
          resolve({ exitCode, signal: exitSignal });
        });
      },
    );

    const tail = await readTail(logPath);

    return { passed: status.exitCode === 0, ...status, logPath, tail };
  } finally {
    await log.close();
  }
};
