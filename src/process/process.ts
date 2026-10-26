import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { groupStateFromTable, stateFromProbe } from './stateDecision.js';
import type { ProcessState } from './stateDecision.js';

export type { ProcessState } from './stateDecision.js';

interface GroupCommandOptions {
  cwd: string;
  signal?: AbortSignal | undefined;
  // Records the command's process group. The command starts only after it resolves.
  onStarted: (groupId: number) => Promise<void>;
}

interface GroupCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type GroupExec = (
  command: string,
  commandArguments: string[],
  options: GroupCommandOptions,
) => Promise<GroupCommandResult>;

const groupPollMilliseconds = 20;

const probe = (processId: number): string | undefined => {
  try {
    process.kill(processId, 0);

    return undefined;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';

    return code;
  }
};

export const processState = (processId: number): ProcessState => stateFromProbe(probe(processId));

const readProcessTable = async (): Promise<string | undefined> => {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pgid=,stat=']);

    return stdout;
  } catch {
    return undefined;
  }
};

export const groupState = async (groupId: number): Promise<ProcessState> => {
  const errorCode = probe(-groupId);

  if (errorCode !== undefined) {
    return stateFromProbe(errorCode);
  }

  return groupStateFromTable(await readProcessTable(), groupId);
};

export const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  try {
    if (child.pid === undefined) {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
};

export const stopGroup = async (child: ChildProcess, graceMilliseconds: number): Promise<void> => {
  const { pid } = child;

  if (pid === undefined) {
    return;
  }

  signalGroup(child, 'SIGTERM');

  const deadline = Date.now() + graceMilliseconds;
  let killed = false;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Each poll depends on the previous one.
    const state = await groupState(pid);

    const unreadableAfterKill = killed && state === 'unknown';

    if (state === 'gone' || unreadableAfterKill) {
      return;
    }

    if (!killed && Date.now() >= deadline) {
      killed = true;
      signalGroup(child, 'SIGKILL');
    }

    // oxlint-disable-next-line no-await-in-loop -- Each poll depends on the previous one.
    await sleep(groupPollMilliseconds);
  }
};

const groupStopGraceMilliseconds = 5000;

// The shell waits for one line on stdin, then becomes the command. If this process dies before it
// sends the line, stdin closes and the shell exits without starting the command.
const startGate = 'read -r gate || exit 1; exec "$0" "$@"';

const spawnGated = (command: string, commandArguments: string[], cwd: string) =>
  spawn('sh', ['-c', startGate, command, ...commandArguments], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

const collectOutput = (child: ReturnType<typeof spawnGated>) => {
  const output = { stdout: '', stderr: '' };

  child.stdout.on('data', (data: Buffer) => {
    output.stdout += data.toString();
  });

  child.stderr.on('data', (data: Buffer) => {
    output.stderr += data.toString();
  });

  return output;
};

const waitForClose = (child: ReturnType<typeof spawnGated>) =>
  new Promise<{ code: number; error?: Error }>((resolve) => {
    child.once('error', (error) => {
      resolve({ code: 1, error });
    });

    child.once('close', (code) => {
      resolve({ code: code ?? 1 });
    });
  });

// Runs a command as the leader of a new process group, which outlives this process. It needs a
// POSIX shell.
export const execInGroup: GroupExec = async (command, commandArguments, options) => {
  const { cwd, signal, onStarted } = options;
  const child = spawnGated(command, commandArguments, cwd);
  const output = collectOutput(child);
  const closed = waitForClose(child);
  let stopping: Promise<void> | undefined;

  const stop = () => {
    stopping ??= stopGroup(child, groupStopGraceMilliseconds);
  };

  // Writing to a shell that already exited fails, and the exit status reports that instead.
  child.stdin.on('error', () => undefined);

  const recordGroup = async (groupId: number): Promise<Error | undefined> => {
    try {
      await onStarted(groupId);
    } catch (error) {
      child.stdin.end();

      return error instanceof Error
        ? error
        : new Error('Recording the command group failed.', { cause: error });
    }

    const gateLine = stopping === undefined ? '\n' : '';

    child.stdin.end(gateLine);

    return undefined;
  };

  const { pid } = child;
  const recorded = pid === undefined ? Promise.resolve(undefined) : recordGroup(pid);

  if (signal?.aborted === true) {
    stop();
  } else {
    signal?.addEventListener('abort', stop, { once: true });
  }

  const [status, recordError] = await Promise.all([closed, recorded]);

  signal?.removeEventListener('abort', stop);
  await stopping;

  if (recordError !== undefined) {
    throw recordError;
  }

  return {
    stdout: output.stdout,
    stderr: status.error?.message ?? output.stderr,
    code: status.code,
    killed: stopping !== undefined,
  };
};
