import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { groupStateFromTable, stateFromProbe } from './stateDecision.ts';
import type { ProcessState } from './stateDecision.ts';

export type { ProcessState } from './stateDecision.ts';

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
  truncated: boolean;
}

export type GroupExec = (
  command: string,
  commandArguments: string[],
  options: GroupCommandOptions,
) => Promise<GroupCommandResult>;

export type GroupStop = 'stopped' | 'unconfirmed';

const timedOut = Symbol('timedOut');

type ProcessTableRead = string | typeof timedOut | undefined;

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

const processTableTimeoutMilliseconds = 2000;

const readProcessTable = async (timeoutMilliseconds: number): Promise<ProcessTableRead> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(timedOut);
    }, timeoutMilliseconds);
  });

  try {
    const read = promisify(execFile)('ps', ['-A', '-o', 'pgid=,stat='], {
      signal: controller.signal,
      killSignal: 'SIGKILL',
    }).then(({ stdout }) => stdout);

    return await Promise.race([read, timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

const readGroupState = async (
  groupId: number,
  timeoutMilliseconds: number,
): Promise<ProcessState | 'timedOut'> => {
  const errorCode = probe(-groupId);

  if (errorCode !== undefined) {
    return stateFromProbe(errorCode);
  }

  const read = await readProcessTable(timeoutMilliseconds);

  return read === timedOut ? 'timedOut' : groupStateFromTable(read, groupId);
};

export const groupState = async (
  groupId: number,
  timeoutMilliseconds = processTableTimeoutMilliseconds,
): Promise<ProcessState> => {
  const state = await readGroupState(groupId, timeoutMilliseconds);

  return state === 'timedOut' ? 'unknown' : state;
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

const killConfirmMilliseconds = 2000;

export const stopGroup = async (
  child: ChildProcess,
  graceMilliseconds: number,
): Promise<GroupStop> => {
  const { pid } = child;

  if (pid === undefined) {
    return 'stopped';
  }

  signalGroup(child, 'SIGTERM');

  const killDeadline = Date.now() + graceMilliseconds;
  let killed = false;
  let confirmDeadline = 0;

  const poll = async (): Promise<GroupStop> => {
    const phaseDeadline = killed ? confirmDeadline : killDeadline;
    const budget = Math.min(processTableTimeoutMilliseconds, phaseDeadline - Date.now());

    if (budget > 0) {
      const state = await readGroupState(pid, budget);

      const unreadableAfterKill = killed && state === 'unknown';

      if (state === 'gone' || unreadableAfterKill) {
        return 'stopped';
      }
    }

    if (!killed && Date.now() >= killDeadline) {
      killed = true;
      confirmDeadline = Date.now() + killConfirmMilliseconds;
      signalGroup(child, 'SIGKILL');
    } else if (killed && Date.now() >= confirmDeadline) {
      return 'unconfirmed';
    }

    await sleep(groupPollMilliseconds);

    return poll();
  };

  return poll();
};

const didNotStopMessage = `The command group did not stop within ${killConfirmMilliseconds} ms after SIGKILL.`;

const appendLine = (text: string, line: string): string =>
  text === '' || text.endsWith('\n') ? `${text}${line}` : `${text}\n${line}`;

export const defaultStopGraceMilliseconds = 5000;

// A grace of zero or NaN would escalate at once or never, so a caller rejects it where it enters.
export const checkStopGraceMilliseconds = (stopGraceMilliseconds: number): void => {
  if (!Number.isSafeInteger(stopGraceMilliseconds) || stopGraceMilliseconds <= 0) {
    throw new RangeError(
      `The stop grace must be a positive safe integer, got ${stopGraceMilliseconds}.`,
    );
  }
};

// The shell waits for one line on stdin, then becomes the command. If this process dies before it
// sends the line, stdin closes and the shell exits without starting the command.
const startGate = 'read -r gate || exit 1; exec "$0" "$@"';

const spawnGated = (command: string, commandArguments: string[], cwd: string) =>
  spawn('sh', ['-c', startGate, command, ...commandArguments], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

const outputCharacterLimit = 1_048_576;

const appendWithinLimit = (
  output: { stdout: string; stderr: string; truncated: boolean },
  stream: 'stdout' | 'stderr',
  data: string,
): void => {
  const remaining = outputCharacterLimit - output.stdout.length - output.stderr.length;

  output.truncated ||= data.length > remaining;

  if (remaining > 0) {
    output[stream] += data.slice(0, remaining);
  }
};

const collectOutput = (child: ReturnType<typeof spawnGated>) => {
  const output = { stdout: '', stderr: '', truncated: false };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (data: string) => {
    appendWithinLimit(output, 'stdout', data);
  });

  child.stderr.on('data', (data: string) => {
    appendWithinLimit(output, 'stderr', data);
  });

  return output;
};

const waitForClose = (child: ReturnType<typeof spawnGated>) =>
  new Promise<{ code: number; error?: Error }>((resolve) => {
    let error: Error | undefined;

    child.once('error', (childError) => {
      error = childError;
    });

    child.once('close', (code) => {
      resolve({ code: code ?? 1, ...(error === undefined ? {} : { error }) });
    });
  });

// Runs a command as the leader of a new process group, which outlives this process. It needs a
// POSIX shell.
export const execInGroup: GroupExec = async (command, commandArguments, options) => {
  const { cwd, signal, onStarted } = options;
  const child = spawnGated(command, commandArguments, cwd);
  const output = collectOutput(child);
  const closed = waitForClose(child);

  let stopping: Promise<GroupStop> | undefined;

  const stop = () => {
    stopping ??= stopGroup(child, defaultStopGraceMilliseconds);
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

  const stopOutcome = stopping === undefined ? undefined : await stopping;

  if (recordError !== undefined) {
    throw recordError;
  }

  const baseStderr = status.error?.message ?? output.stderr;

  const stderr =
    stopOutcome === 'unconfirmed' ? appendLine(baseStderr, didNotStopMessage) : baseStderr;

  return {
    stdout: output.stdout,
    stderr,
    code: status.code,
    killed: stopping !== undefined,
    truncated: output.truncated,
  };
};
