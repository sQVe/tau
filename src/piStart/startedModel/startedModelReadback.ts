import { setTimeout as sleep } from 'node:timers/promises';

import { parseModelReference } from '../../config/models.js';
import { errorMessage, toError } from '../../errors.js';
import { piArgv } from '../startedArgv.js';
import { decideStartedModel } from './startedModel.js';
import type { RequestedModel, StartedModelDecision } from './startedModel.js';

export type ReadForegroundArgv = (
  terminal: string,
  signal: AbortSignal,
) => Promise<readonly string[] | undefined>;

export interface StartedModelReadRequest {
  readForegroundArgv: ReadForegroundArgv;
  terminal: string;
  model: string | undefined;
  signal: AbortSignal | undefined;
  deadline: number;
}

// Records a failed read. A failure that outlasts the failure budget is not a terminal that has
// not registered yet, so it stops the readback.
interface ReadFailures {
  error: unknown;
  since: number | undefined;
}

const readbackInitialIntervalMilliseconds = 100;
const readbackMaxIntervalMilliseconds = 1000;

// A read that keeps failing is not a terminal that has not registered yet, so stop polling after
// this window and report the failure instead of the whole readback budget.
export const readbackFailureBudgetMilliseconds = 5_000;

const requestedModelOf = (model: string | undefined): RequestedModel => {
  if (model === undefined) {
    return { provider: undefined, id: undefined };
  }

  return parseModelReference(model) ?? { provider: undefined, id: model };
};

const stillRunningHint = (terminal: string): string =>
  `It may still be running; check it with hc get ${terminal} before you start another.`;

const unreadableModelError = (terminal: string, cause?: unknown): Error => {
  const options = cause === undefined ? undefined : { cause };
  const failure = cause === undefined ? '' : ` A read failed: ${errorMessage(cause)}.`;

  return new Error(
    `The started model on terminal ${terminal} is unknown.${failure} ${stillRunningHint(terminal)}`,
    options,
  );
};

const mismatchModelError = (
  terminal: string,
  decision: Extract<StartedModelDecision, { kind: 'mismatch' }>,
): Error =>
  new Error(
    `The started Pi on terminal ${terminal} runs ${decision.started}, but the request asked for ${decision.requested}. ${stillRunningHint(terminal)}`,
  );

const cancellationError = (signal: AbortSignal | undefined): Error => {
  const reason: unknown = signal?.reason;

  return reason instanceof Error
    ? reason
    : new Error('The started model readback was cancelled.', { cause: reason });
};

// A pause between reads rejects as soon as the signal aborts, so cancelling stays prompt.
const pauseBeforeRead = async (
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const options = signal === undefined ? {} : { signal };

  try {
    await sleep(milliseconds, undefined, options);
  } catch (error) {
    if (signal?.aborted === true) {
      throw cancellationError(signal);
    }

    throw toError(error);
  }
};

// Each read shares one deadline with the whole readback, so a slow terminal cannot extend the
// launch budget. The read gets its own signal, so the command is cancelled when the budget expires.
// A synchronous throw from the read must clear the timer and the listener it already registered.
const readWithinBudget = (
  read: (signal: AbortSignal) => Promise<readonly string[] | undefined>,
  remaining: number,
  signal: AbortSignal | undefined,
): Promise<readonly string[] | undefined> =>
  new Promise((resolve, reject) => {
    const readSignal = new AbortController();

    const onAbort = (): void => {
      clearTimeout(timer);
      readSignal.abort();
      reject(cancellationError(signal));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      readSignal.abort();
      resolve(undefined);
    }, remaining);

    const settle = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted === true) {
      onAbort();

      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      void read(readSignal.signal).then(
        (argv) => {
          settle();
          resolve(argv);
        },
        (error: unknown) => {
          settle();
          reject(toError(error));
        },
      );
    } catch (error) {
      settle();
      reject(toError(error));
    }
  });

const noteReadFailure = (failures: ReadFailures, error: unknown, now: number): boolean => {
  failures.error ??= error;
  failures.since ??= now;

  return now - failures.since >= readbackFailureBudgetMilliseconds;
};

export const readStartedModel = async (request: StartedModelReadRequest): Promise<string> => {
  const { readForegroundArgv, terminal, model, signal, deadline } = request;
  const requested = requestedModelOf(model);

  const failures: ReadFailures = {
    error: undefined,
    since: undefined,
  };

  let interval = readbackInitialIntervalMilliseconds;

  for (;;) {
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      throw unreadableModelError(terminal, failures.error);
    }

    let argv: readonly string[] | undefined;

    try {
      // oxlint-disable-next-line no-await-in-loop -- each read must wait for the previous one.
      argv = await readWithinBudget(
        (readSignal) => readForegroundArgv(terminal, readSignal),
        remaining,
        signal,
      );

      failures.error = undefined;
      failures.since = undefined;
    } catch (error) {
      if (signal?.aborted === true) {
        throw cancellationError(signal);
      }

      if (noteReadFailure(failures, error, Date.now())) {
        throw unreadableModelError(terminal, failures.error);
      }

      argv = undefined;
    }

    const startedArgv = piArgv(argv);

    if (startedArgv !== undefined) {
      const decision = decideStartedModel({ requested, argv: startedArgv });

      if (decision.kind === 'match') {
        return decision.model;
      }

      if (decision.kind === 'mismatch') {
        throw mismatchModelError(terminal, decision);
      }

      throw unreadableModelError(terminal);
    }

    const remainingAfterRead = deadline - Date.now();

    if (remainingAfterRead <= 0) {
      throw unreadableModelError(terminal, failures.error);
    }

    // oxlint-disable-next-line no-await-in-loop -- the poll needs a pause between reads.
    await pauseBeforeRead(Math.min(interval, remainingAfterRead), signal);

    interval = Math.min(interval * 2, readbackMaxIntervalMilliseconds);
  }
};
