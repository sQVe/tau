import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { errorMessage } from '../../errors.js';
import {
  checkStopGraceMilliseconds,
  defaultStopGraceMilliseconds,
  stopGroup,
} from '../../process/process.js';
import type { GroupStop } from '../../process/process.js';

export interface CommandOptions {
  argv: readonly string[];
  cwd: string;
  logPath: string;
  environment: Readonly<Record<string, string>>;
  deadlineMilliseconds: number;
  signal: AbortSignal | undefined;
  // How long a stopped command may ignore SIGTERM before SIGKILL.
  stopGraceMilliseconds?: number;
}

export type CommandOutcome =
  | { kind: 'exited'; exitCode: number }
  | { kind: 'signalled'; signal: string }
  | { kind: 'stopped'; reason: 'deadline' | 'cancelled' }
  | { kind: 'notStarted'; message: string };

interface CommandState {
  stop: {
    stopping: Promise<GroupStop> | undefined;
    reason: 'deadline' | 'cancelled' | undefined;
  };
  startFailure: Promise<string> | undefined;
}

const largestTimerDelayMilliseconds = 2_147_483_647;

const isPositiveSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const checkCommandOptions = (options: CommandOptions): void => {
  if (options.argv.length === 0) {
    throw new RangeError('A command needs at least one argument.');
  }

  if (!isPositiveSafeInteger(options.deadlineMilliseconds)) {
    throw new RangeError(
      `The deadline must be a positive safe integer, got ${options.deadlineMilliseconds}.`,
    );
  }

  if (options.deadlineMilliseconds > largestTimerDelayMilliseconds) {
    throw new RangeError(
      `The deadline must be at most ${largestTimerDelayMilliseconds} ms, got ${options.deadlineMilliseconds}.`,
    );
  }

  const { stopGraceMilliseconds } = options;

  if (stopGraceMilliseconds !== undefined) {
    checkStopGraceMilliseconds(stopGraceMilliseconds);
  }
};

const appendFailure = async (log: FileHandle, error: unknown): Promise<string> => {
  const message = errorMessage(error);

  await log.write(`${message}\n`);

  return message;
};

const stopChild = (
  state: CommandState,
  child: ChildProcess,
  reason: 'deadline' | 'cancelled',
  stopGraceMilliseconds: number,
): void => {
  if (state.stop.stopping !== undefined) {
    return;
  }

  state.stop.reason = reason;
  state.stop.stopping = stopGroup(child, stopGraceMilliseconds);
};

const outcomeAfterClose = async (
  state: CommandState,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | null,
): Promise<CommandOutcome> => {
  if (state.startFailure !== undefined) {
    const message = await state.startFailure;

    return { kind: 'notStarted', message };
  }

  await state.stop.stopping;

  if (state.stop.reason !== undefined) {
    return { kind: 'stopped', reason: state.stop.reason };
  }

  if (exitCode !== null) {
    return { kind: 'exited', exitCode };
  }

  if (exitSignal !== null) {
    return { kind: 'signalled', signal: exitSignal };
  }

  throw new Error('The command closed without an exit code or a signal.');
};

const runOpenedCommand = (options: CommandOptions, log: FileHandle): Promise<CommandOutcome> =>
  new Promise<CommandOutcome>((resolve, reject) => {
    const {
      argv,
      cwd,
      environment,
      deadlineMilliseconds,
      signal,
      stopGraceMilliseconds = defaultStopGraceMilliseconds,
    } = options;

    const [command = '', ...commandArguments] = argv;

    let child: ChildProcess;

    try {
      child = spawn(command, commandArguments, {
        cwd,
        stdio: ['ignore', log.fd, log.fd],
        detached: true,
        // oxlint-disable-next-line node/no-process-env -- The command keeps the caller's environment.
        env: { ...process.env, ...environment },
      });
    } catch (error) {
      void appendFailure(log, error).then((message) => {
        resolve({ kind: 'notStarted', message });
      }, reject);

      return;
    }

    const state: CommandState = {
      stop: { stopping: undefined, reason: undefined },
      startFailure: undefined,
    };

    const onAbort = () => {
      stopChild(state, child, 'cancelled', stopGraceMilliseconds);
    };

    const deadline = setTimeout(() => {
      stopChild(state, child, 'deadline', stopGraceMilliseconds);
    }, deadlineMilliseconds);

    child.once('error', (error) => {
      const failure = appendFailure(log, error);

      state.startFailure = failure;
      void failure.catch(() => undefined);
    });

    child.once('close', (exitCode, exitSignal) => {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);

      void outcomeAfterClose(state, exitCode, exitSignal).then(resolve, reject);
    });

    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const runCommand = async (options: CommandOptions): Promise<CommandOutcome> => {
  checkCommandOptions(options);

  const { signal } = options;
  const log = await open(options.logPath, 'wx');

  try {
    if (isAborted(signal)) {
      return { kind: 'stopped', reason: 'cancelled' };
    }

    return await runOpenedCommand(options, log);
  } finally {
    await log.close();
  }
};
