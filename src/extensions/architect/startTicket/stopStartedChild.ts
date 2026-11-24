import { setTimeout as sleep } from 'node:timers/promises';

import { processState } from '../../../process/process.js';
import type { ProcessState } from '../../../process/process.js';

export interface StopStartedChildOptions {
  stateOf?: (processId: number) => ProcessState;
  signal?: (processId: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  // Asked before each signal. A child that adopted is no longer this caller's to stop.
  adopted?: () => Promise<boolean>;
}

type StopOptions = Required<StopStartedChildOptions>;

const stopWindowMilliseconds = 10_000;
const termWindowMilliseconds = 5_000;
const pollMilliseconds = 300;

const signalProcess = (processId: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(processId, signal);
  } catch {
    // A signal that cannot be sent leaves the state read to decide.
  }
};

const defaultOptions: StopOptions = {
  stateOf: processState,
  signal: signalProcess,
  now: () => Date.now(),
  sleep: (milliseconds) => sleep(milliseconds),
  adopted: () => Promise.resolve(false),
};

const waitForStop = async (
  processId: number,
  limit: number,
  options: StopOptions,
): Promise<ProcessState> => {
  for (;;) {
    const state = options.stateOf(processId);

    if (state !== 'running') {
      return state;
    }

    const remaining = limit - options.now();

    if (remaining <= 0) {
      return 'running';
    }

    // oxlint-disable-next-line no-await-in-loop -- Each poll waits for the previous state to change.
    await options.sleep(Math.min(pollMilliseconds, remaining));
  }
};

// Stops the process that took a start ticket. One absolute deadline covers both signals.
export const stopStartedChild = async (
  processId: number,
  requested: StopStartedChildOptions = {},
): Promise<ProcessState> => {
  const options: StopOptions = { ...defaultOptions, ...requested };
  const deadline = options.now() + stopWindowMilliseconds;
  const initial = options.stateOf(processId);

  if (initial !== 'running') {
    return initial;
  }

  if (await options.adopted()) {
    return initial;
  }

  options.signal(processId, 'SIGTERM');

  const termDeadline = Math.min(options.now() + termWindowMilliseconds, deadline);
  const afterTerm = await waitForStop(processId, termDeadline, options);

  if (afterTerm !== 'running' || options.now() >= deadline) {
    return afterTerm;
  }

  if (await options.adopted()) {
    return afterTerm;
  }

  options.signal(processId, 'SIGKILL');

  return waitForStop(processId, deadline, options);
};
