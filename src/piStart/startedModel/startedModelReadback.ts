import { setTimeout as sleep } from 'node:timers/promises';

import { normalizeCancellation } from '../../command.js';
import { parseModelReference } from '../../config/models.js';
import { errorMessage, toError } from '../../errors.js';
import { shellScriptOf } from '../../shell/shellScript.js';
import { executableName, piArgv } from '../startedArgv.js';
import { decideStartedModel } from './startedModel.js';
import type { RequestedModel, StartedModelDecision } from './startedModel.js';

export type ReadForegroundArgv = (
  terminal: string,
  signal: AbortSignal,
) => Promise<readonly string[] | undefined>;

interface StartedModelReadRequest {
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

type ReadAttempt =
  | {
      readonly kind: 'read';
      readonly argv: readonly string[] | undefined;
      readonly failure: ReadFailure | undefined;
    }
  | { readonly kind: 'timeout'; readonly failure: ReadFailure };

interface PollState {
  readonly failure: ReadFailure | undefined;
  readonly interval: number;
  readonly nonPiSince: number | undefined;
}

const readbackInitialIntervalMilliseconds = 100;
const readbackMaxIntervalMilliseconds = 1000;

// A read that keeps failing is not a terminal that has not registered yet, so stop polling after
// this window and report the failure instead of the whole readback budget.
export const readbackFailureBudgetMilliseconds = 5_000;

// A terminal that shows a foreground that is not Pi (Pi exited on a bad flag, or the pane shows a
// shell) is not going to change, so report it without using the whole readback budget. A terminal
// that shows no foreground at all, or a shell that runs a launch wrapper and may still exec Pi,
// keeps the caller's deadline.
export const readbackNoForegroundBudgetMilliseconds = 15_000;

// The architect launch wraps Pi in `sh -c`, so the pane shows that wrapper before Pi takes over.
// The shell module owns the shell names and the `-c` parsing, including combined flags. The first
// word keeps the executable spelling, so normalize it before the shell module reads it.
const runsShellScript = (argv: readonly string[]): boolean => {
  const [executable, ...rest] = argv;
  const normalized = executable === undefined ? argv : [executableName(executable), ...rest];

  return shellScriptOf(normalized).kind !== 'none';
};

const requestedModelOf = (model: string | undefined): RequestedModel => {
  if (model === undefined) {
    return { kind: 'default' };
  }

  const parsed = parseModelReference(model);

  return parsed === undefined
    ? { kind: 'model', provider: undefined, id: model }
    : { kind: 'model', ...parsed };
};

const unreadableModelError = (terminal: string, cause?: unknown): Error => {
  const options = cause === undefined ? undefined : { cause };
  const failure = cause === undefined ? '' : ` A read failed: ${errorMessage(cause)}.`;

  return new Error(`The started model on terminal ${terminal} is unknown.${failure}`, options);
};

const mismatchModelError = (
  terminal: string,
  decision: Extract<StartedModelDecision, { kind: 'mismatch' }>,
): Error =>
  new Error(
    `The started Pi on terminal ${terminal} runs ${decision.started}, but the request asked for ${decision.requested}.`,
  );

const cancellationError = (signal: AbortSignal | undefined): Error =>
  toError(
    normalizeCancellation(signal, signal?.reason, 'The started model readback was cancelled.'),
  );

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

// A read that uses the rest of the budget returns no argv and keeps the recorded failure, so the
// deadline error still names it. A read that times out records that reason instead of reading as a
// terminal with no foreground yet.
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

    if (read.kind === 'read') {
      return { kind: 'read', argv: read.argv, failure: undefined };
    }

    const timeout = new Error('the read timed out');

    return { kind: 'timeout', failure: noteReadFailure(failure, timeout, Date.now()) };
  } catch (error) {
    if (request.signal?.aborted === true) {
      throw cancellationError(request.signal);
    }

    const now = Date.now();
    const next = noteReadFailure(failure, error, now);

    if (now - next.since >= readbackFailureBudgetMilliseconds) {
      throw unreadableModelError(request.terminal, next.error);
    }

    return { kind: 'read', argv: undefined, failure: next };
  }
};

const attemptArgv = (attempt: ReadAttempt): readonly string[] | undefined =>
  attempt.kind === 'read' ? attempt.argv : undefined;

// A timeout is not a terminal with no foreground yet, so it must not discard an armed streak. A
// read with no foreground, or a shell wrapper that may still exec Pi, keeps the caller deadline. A
// failed read carries no foreground fact, so it must not discard the streak either.
const streakAfter = (attempt: ReadAttempt, nonPiSince: number | undefined): number | undefined => {
  if (attempt.kind === 'timeout') {
    return nonPiSince;
  }

  const noForeground = attempt.argv === undefined && attempt.failure === undefined;
  const transientWrapper = attempt.argv !== undefined && runsShellScript(attempt.argv);
  const keepsDeadline = noForeground || transientWrapper;

  return keepsDeadline ? undefined : (nonPiSince ?? Date.now());
};

const pollStartedModel = async (
  request: StartedModelReadRequest,
  requested: RequestedModel,
  state: PollState,
): Promise<string> => {
  const { terminal, signal, deadline } = request;
  const { failure, interval, nonPiSince } = state;

  const limitOf = (since: number | undefined): number =>
    since === undefined
      ? deadline
      : Math.min(deadline, since + readbackNoForegroundBudgetMilliseconds);

  const remaining = limitOf(nonPiSince) - Date.now();

  if (remaining <= 0) {
    throw unreadableModelError(terminal, failure?.error);
  }

  const attempt = await attemptRead(request, failure, remaining);
  const argv = attemptArgv(attempt);
  const startedArgv = piArgv(argv);

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

  const nextNonPiSince = streakAfter(attempt, nonPiSince);

  const remainingAfterRead = limitOf(nextNonPiSince) - Date.now();

  if (remainingAfterRead <= 0) {
    throw unreadableModelError(terminal, attempt.failure?.error);
  }

  await pauseBeforeRead(Math.min(interval, remainingAfterRead), signal);

  return pollStartedModel(request, requested, {
    failure: attempt.failure,
    interval: Math.min(interval * 2, readbackMaxIntervalMilliseconds),
    nonPiSince: nextNonPiSince,
  });
};

const initialPollState: PollState = {
  failure: undefined,
  interval: readbackInitialIntervalMilliseconds,
  nonPiSince: undefined,
};

export const readStartedModel = (request: StartedModelReadRequest): Promise<string> =>
  pollStartedModel(request, requestedModelOf(request.model), initialPollState);
