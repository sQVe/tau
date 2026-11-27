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
  message: string | undefined;
  signal: AbortSignal | undefined;
  deadline: number;
}

// Records a failed read and when its streak started. A terminal that has not registered yet reads
// as no foreground argv, so a thrown failure is a real read failure, not a terminal still starting.
interface ReadFailure {
  error: unknown;
  since: number;
}

type ReadWithinBudget =
  | { readonly kind: 'read'; readonly argv: readonly string[] | undefined }
  | { readonly kind: 'timeout' };

interface ReadAttempt {
  readonly argv: readonly string[] | undefined;
  readonly failure: ReadFailure | undefined;
}

const readbackInitialIntervalMilliseconds = 100;
const readbackMaxIntervalMilliseconds = 1000;

// A read that keeps failing is not a terminal that has not registered yet, so stop polling after
// this window and report the failure instead of the whole readback budget.
export const readbackFailureBudgetMilliseconds = 5_000;

// A terminal that shows a foreground that is not Pi (Pi exited on a bad flag, or the pane shows a
// shell) is not going to change, so report it without using the whole readback budget. A terminal
// that shows no foreground at all may still be starting, so it keeps the caller's deadline.
export const readbackNoForegroundBudgetMilliseconds = 15_000;

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
  const hint = cause === undefined ? ` ${stillRunningHint(terminal)}` : '';

  return new Error(
    `The started model on terminal ${terminal} is unknown.${failure}${hint}`,
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
): Promise<ReadWithinBudget> =>
  new Promise((resolve, reject) => {
    const readController = new AbortController();

    const onAbort = (): void => {
      clearTimeout(timer);
      readController.abort();
      reject(cancellationError(signal));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      readController.abort();
      resolve({ kind: 'timeout' });
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
      void read(readController.signal).then(
        (argv) => {
          settle();
          resolve({ kind: 'read', argv });
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

const noteReadFailure = (
  previous: ReadFailure | undefined,
  error: unknown,
  now: number,
): ReadFailure => previous ?? { error, since: now };

// A read that uses the rest of the budget returns no argv and leaves the recorded failure in place,
// so the deadline error still names it.
const attemptRead = async (
  request: StartedModelReadRequest,
  failure: ReadFailure | undefined,
  remaining: number,
): Promise<ReadAttempt> => {
  try {
    const read = await readWithinBudget(
      (readSignal) => request.readForegroundArgv(request.terminal, readSignal),
      remaining,
      request.signal,
    );

    return read.kind === 'read'
      ? { argv: read.argv, failure: undefined }
      : { argv: undefined, failure };
  } catch (error) {
    if (request.signal?.aborted === true) {
      throw cancellationError(request.signal);
    }

    const now = Date.now();
    const next = noteReadFailure(failure, error, now);

    if (now - next.since >= readbackFailureBudgetMilliseconds) {
      throw unreadableModelError(request.terminal, next.error);
    }

    return { argv: undefined, failure: next };
  }
};

const pollStartedModel = async (
  request: StartedModelReadRequest,
  requested: RequestedModel,
  failure: ReadFailure | undefined,
  interval: number,
  nonPiSince: number | undefined,
): Promise<string> => {
  const { terminal, signal, deadline } = request;

  const limitOf = (since: number | undefined): number =>
    since === undefined
      ? deadline
      : Math.min(deadline, since + readbackNoForegroundBudgetMilliseconds);

  const remaining = limitOf(nonPiSince) - Date.now();

  if (remaining <= 0) {
    throw unreadableModelError(terminal, failure?.error);
  }

  const attempt = await attemptRead(request, failure, remaining);
  const startedArgv = piArgv(attempt.argv);

  if (startedArgv !== undefined) {
    const decision = decideStartedModel({
      requested,
      argv: startedArgv,
      message: request.message,
    });

    if (decision.kind === 'match') {
      return decision.model;
    }

    if (decision.kind === 'mismatch') {
      throw mismatchModelError(terminal, decision);
    }

    throw unreadableModelError(terminal);
  }

  const nextNonPiSince = nonPiSince ?? (attempt.argv === undefined ? undefined : Date.now());
  const remainingAfterRead = limitOf(nextNonPiSince) - Date.now();

  if (remainingAfterRead <= 0) {
    throw unreadableModelError(terminal, attempt.failure?.error);
  }

  await pauseBeforeRead(Math.min(interval, remainingAfterRead), signal);

  return pollStartedModel(
    request,
    requested,
    attempt.failure,
    Math.min(interval * 2, readbackMaxIntervalMilliseconds),
    nextNonPiSince,
  );
};

export const readStartedModel = (request: StartedModelReadRequest): Promise<string> =>
  pollStartedModel(
    request,
    requestedModelOf(request.model),
    undefined,
    readbackInitialIntervalMilliseconds,
    undefined,
  );
