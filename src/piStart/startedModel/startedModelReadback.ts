import { setTimeout as sleep } from 'node:timers/promises';

import { parseModelReference } from '../../config/models.js';
import { toError } from '../../errors.js';
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

const readbackInitialIntervalMilliseconds = 100;
const readbackMaxIntervalMilliseconds = 1000;

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

  return new Error(
    `The started model on terminal ${terminal} is unknown. ${stillRunningHint(terminal)}`,
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

    if (signal?.aborted === true) {
      onAbort();

      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    void read(readSignal.signal).then(
      (argv) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(argv);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(toError(error));
      },
    );
  });

export const readStartedModel = async (request: StartedModelReadRequest): Promise<string> => {
  const { readForegroundArgv, terminal, model, signal, deadline } = request;
  const requested = requestedModelOf(model);
  let interval = readbackInitialIntervalMilliseconds;
  let readError: unknown;

  for (;;) {
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      throw unreadableModelError(terminal, readError);
    }

    let argv: readonly string[] | undefined;

    try {
      // oxlint-disable-next-line no-await-in-loop -- each read must wait for the previous one.
      argv = await readWithinBudget(
        (readSignal) => readForegroundArgv(terminal, readSignal),
        remaining,
        signal,
      );
    } catch (error) {
      if (signal?.aborted === true) {
        throw cancellationError(signal);
      }

      readError = error;
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
      throw unreadableModelError(terminal, readError);
    }

    // oxlint-disable-next-line no-await-in-loop -- the poll needs a pause between reads.
    await pauseBeforeRead(Math.min(interval, remainingAfterRead), signal);

    interval = Math.min(interval * 2, readbackMaxIntervalMilliseconds);
  }
};
