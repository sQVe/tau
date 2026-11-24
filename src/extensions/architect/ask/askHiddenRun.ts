import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { errorMessage } from '../../../errors.js';
import { kill, run, wait } from '../../../hc/hc.js';
import { piArguments } from '../../../piStart/piArguments.js';
import { launchTimeoutMilliseconds } from '../../../piStart/piStart.js';
import { processState } from '../../../process/process.js';
import { launchOutcomeDecision } from '../claimRelease/launchOutcomeDecision.js';
import type { LaunchOutcome } from '../claimRelease/launchOutcomeDecision.js';
import { askRecordPath, updateHiddenAskRecord, writeAskRecord } from '../record.js';
import type { ChangeAskOptions, HiddenAskRecord, HiddenAskRecordChange } from '../record.js';
import type { StartFence, StartFenceCompletion } from '../startFence/startFence.js';
import type { AskRequest, AskResult } from './ask.js';
import { askDeadlineDetail, askRecordOutcome } from './askDecision.js';

interface HiddenAskLaunch {
  outcome: LaunchOutcome;
  terminal: string | undefined;
  error: unknown;
}

type SettleHiddenAsk = () => Promise<StartFenceCompletion>;

export interface HiddenAskRun {
  start: (sessionFile: string, model: string) => Promise<AskResult>;
  settle: SettleHiddenAsk;
}

type HiddenAskLaunchResult =
  | { kind: 'started'; started: HiddenAskRecord; terminal: string }
  | { kind: 'settled'; result: AskResult };

export const askDeadlineSeconds = 900;

export const askKeptClaimMessage = (root: string, failure?: Error): string => {
  const message = `The architect in ${root} did not take the checkout lock, so the checkout stays reserved until this lead session exits. Stop the started terminal, or end this lead session, before calling architect ask again.`;

  return failure === undefined ? message : `${message} ${failure.message}`;
};

export const askMissingRecordReason =
  'The ask record could not be read after the ask settled. Call architect open to talk to the architect.';

export const askUnreadableAnswerReason =
  'The architect sent an answer that could not be read. Call architect open to talk to the architect.';

export const askUnconfirmedStopDetail =
  'The ask terminal did not confirm that it stopped. The ask ends at its deadline.';

export const askTimeoutStopDetail =
  'The ask reached its deadline, and its terminal did not confirm that it stopped. The record stays running until another ask repairs it.';

export const askTimeoutStopReason =
  'The ask reached its deadline, but its terminal did not confirm that it stopped. Call architect open to talk to the architect.';

export const askLaunchFailureDetail = 'The ask terminal could not be started.';

const askWaitFailureDetail = (cancelled: boolean, error: unknown): string =>
  `The ask wait was ${cancelled ? 'cancelled' : 'failed'}: ${errorMessage(error)}`;

export const askAdoptedChildStoppedDetail =
  'The ask wait ended when its adopted child stopped before the architect answered.';

const askDeadlineReason =
  'The ask reached its deadline. Call architect open to talk to the architect.';

export const askEndedReason =
  'The architect ended without sending an answer. Call architect open to talk to it.';

export const askEndedDetail = 'The ask ended without sending an answer.';

export const askEndedFailureDetail = 'The ask terminal failed before the architect answered.';

export const askFailedReason =
  'The ask terminal failed before the architect answered. Call architect open instead.';

const millisecondsPerSecond = 1000;
const adoptedChildPollMilliseconds = 100;

const needsOpen = (reason: string): AskResult => ({ status: 'needsOpen', reason });

const hiddenAskLaunch = async (
  request: AskRequest,
  initial: HiddenAskRecord,
  recordPath: string,
  model: string,
  fence: StartFence,
): Promise<HiddenAskLaunch> => {
  const hc = { ...request.hc, signal: undefined };

  try {
    const terminal = await run(hc, {
      argv: fence.wrapArgv(
        piArguments({
          model,
          session: initial.sessionFile,
          environment: {
            TAU_ROLE: 'architect',
            TAU_ARCHITECT_ASK: recordPath,
            TAU_LEAD_TERMINAL: request.leadTerminal,
            TAU_ARCHITECT_CLAIM: fence.token,
          },
          message: request.question,
        }),
      ),
      cwd: request.root,
      background: true,
      noParent: true,
      notify: false,
      labels: { 'tau.architect.ask': initial.askId },
      execTimeoutMilliseconds: launchTimeoutMilliseconds,
    });

    const replyTerminal = terminal.address === '' ? 'malformed' : 'valid';

    const outcome = launchOutcomeDecision({
      exitCode: 0,
      killed: false,
      aborted: false,
      replyTerminal,
    });

    const created = outcome === 'created';

    return {
      outcome,
      terminal: created ? terminal.address : undefined,
      error: created ? undefined : new Error('hc run printed no usable terminal address'),
    };
  } catch (error) {
    return { outcome: 'notCreated', terminal: undefined, error };
  }
};

const stopAskTerminal = async (request: AskRequest, terminal: string): Promise<void> => {
  await kill({ ...request.hc, signal: undefined }, terminal).catch(() => undefined);
};

const resultFromRecord = (
  root: string,
  askId: string,
  record: HiddenAskRecord | undefined,
): AskResult => {
  if (record === undefined) {
    return needsOpen(askMissingRecordReason);
  }

  const outcome = askRecordOutcome({ status: record.status, answer: record.answer });

  if (outcome === 'answered' && record.answer !== null) {
    return { status: 'ended', askId, answer: record.answer };
  }

  if (outcome === 'deadline') {
    return needsOpen(askDeadlineReason);
  }

  if (outcome === 'failed') {
    return { status: 'failed', askId, reason: askFailedReason };
  }

  if (outcome === 'kept') {
    return needsOpen(askKeptClaimMessage(root));
  }

  return needsOpen(askUnreadableAnswerReason);
};

const adoptedChildPoll = async (signal: AbortSignal | undefined): Promise<void> => {
  const options = signal === undefined ? {} : { signal };

  await sleep(adoptedChildPollMilliseconds, undefined, options).catch(() => undefined);
};

const signalAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const waitForAdoptedChild = async (
  started: HiddenAskRecord,
  fence: StartFence,
  signal: AbortSignal | undefined,
): Promise<boolean> => {
  const childPid = fence.childProcessId();

  if (childPid === undefined) {
    return false;
  }

  let state = processState(childPid);

  while (state !== 'gone' && Date.now() < started.deadline && !signalAborted(signal)) {
    // oxlint-disable-next-line no-await-in-loop -- Each poll waits for the child to change state.
    await adoptedChildPoll(signal);

    state = processState(childPid);
  }

  return state === 'gone';
};

// An adopted child owns the claim, so the lead writes nothing until the kernel reads its pid gone.
const settleAdoptedChild = async (
  request: AskRequest,
  started: HiddenAskRecord,
  fence: StartFence,
  options: ChangeAskOptions,
): Promise<HiddenAskRecordChange | undefined> => {
  const childGone = await waitForAdoptedChild(started, fence, request.hc.signal);

  const changed = await updateHiddenAskRecord(
    request.root,
    started.askId,
    (current) =>
      childGone
        ? { ...current, status: 'failed', detail: askAdoptedChildStoppedDetail }
        : undefined,
    options,
  );

  request.hc.signal?.throwIfAborted();

  return changed;
};

const launchHiddenRecord = async (
  request: AskRequest,
  initial: HiddenAskRecord,
  recordPath: string,
  model: string,
  fence: StartFence,
  options: ChangeAskOptions,
): Promise<HiddenAskLaunchResult> => {
  const launched = await hiddenAskLaunch(request, initial, recordPath, model, fence);

  await fence.recordStarted();

  if (launched.outcome === 'created' && launched.terminal !== undefined) {
    const started: HiddenAskRecord = { ...initial, terminal: launched.terminal };

    await updateHiddenAskRecord(request.root, initial.askId, (current) => ({
      ...current,
      terminal: launched.terminal ?? null,
    }));

    return { kind: 'started', started, terminal: launched.terminal };
  }

  const completion = await fence.complete();

  if (completion.outcome === 'adopted') {
    const changed = await settleAdoptedChild(request, initial, fence, options);

    return {
      kind: 'settled',
      result: resultFromRecord(request.root, initial.askId, changed?.record),
    };
  }

  if (completion.outcome === 'unresolved') {
    await updateHiddenAskRecord(
      request.root,
      initial.askId,
      (current) => ({ ...current, status: 'running', detail: askUnconfirmedStopDetail }),
      options,
    );

    return {
      kind: 'settled',
      result: needsOpen(askKeptClaimMessage(request.root, completion.failure)),
    };
  }

  const changed = await updateHiddenAskRecord(
    request.root,
    initial.askId,
    (current) => ({ ...current, status: 'failed', detail: askLaunchFailureDetail }),
    options,
  );

  if (completion.outcome === 'cancelled') {
    throw launched.error;
  }

  return {
    kind: 'settled',
    result: resultFromRecord(request.root, initial.askId, changed?.record),
  };
};

const settleWaitFailure = async (
  request: AskRequest,
  started: HiddenAskRecord,
  fence: StartFence,
  terminal: string,
  settle: SettleHiddenAsk,
  error: unknown,
  options: ChangeAskOptions,
): Promise<AskResult> => {
  const cancelled = request.hc.signal?.aborted === true;

  await stopAskTerminal(request, terminal);

  const completion = await settle();

  const changed =
    completion.outcome === 'adopted'
      ? await settleAdoptedChild(request, started, fence, options)
      : await updateHiddenAskRecord(
          request.root,
          started.askId,
          (current) => ({
            ...current,
            status: completion.outcome === 'unresolved' ? 'running' : 'failed',
            detail:
              completion.outcome === 'unresolved'
                ? askUnconfirmedStopDetail
                : askWaitFailureDetail(cancelled, error),
          }),
          options,
        );

  const record = changed?.record;

  if (completion.claim === 'kept') {
    throw new Error(askKeptClaimMessage(request.root, completion.failure));
  }

  if (completion.outcome === 'cancelled') {
    throw error;
  }

  return resultFromRecord(request.root, started.askId, record);
};

const settleTimeout = async (
  request: AskRequest,
  started: HiddenAskRecord,
  terminal: string,
  settle: SettleHiddenAsk,
  options: ChangeAskOptions,
): Promise<AskResult> => {
  await stopAskTerminal(request, terminal);

  const completion = await settle();

  const unconfirmed = completion.outcome === 'adopted' || completion.outcome === 'unresolved';
  const status = unconfirmed ? 'running' : 'timeout';
  const detail = unconfirmed ? askTimeoutStopDetail : askDeadlineDetail;

  const changed = await updateHiddenAskRecord(
    request.root,
    started.askId,
    (current) => ({ ...current, status, detail }),
    options,
  );

  const record = changed?.record;

  if (record?.status === 'running') {
    const reason =
      completion.claim === 'kept'
        ? askKeptClaimMessage(request.root, completion.failure)
        : askTimeoutStopReason;

    return needsOpen(reason);
  }

  return resultFromRecord(request.root, started.askId, record);
};

const settleEnded = async (
  request: AskRequest,
  askId: string,
  exitCode: number | null,
  exitSignal: number | null,
  options: ChangeAskOptions,
): Promise<AskResult> => {
  const stoppedBySignal = exitSignal !== null;
  const nonZeroExit = exitCode !== null && exitCode !== 0;
  const failed = stoppedBySignal || nonZeroExit;
  const detail = failed ? askEndedFailureDetail : askEndedDetail;

  const changed = await updateHiddenAskRecord(
    request.root,
    askId,
    (current) => ({
      ...current,
      status: 'failed',
      detail,
    }),
    options,
  );

  if (changed?.changed === true) {
    return failed
      ? { status: 'failed', askId, reason: askFailedReason }
      : needsOpen(askEndedReason);
  }

  return resultFromRecord(request.root, askId, changed?.record);
};

const runHiddenAsk = async (
  request: AskRequest,
  sessionFile: string,
  model: string,
  fence: StartFence,
  settle: SettleHiddenAsk,
  options: ChangeAskOptions,
): Promise<AskResult> => {
  const askId = randomUUID();
  const recordPath = askRecordPath(request.root, askId);

  const initial: HiddenAskRecord = {
    version: 3,
    route: 'hidden',
    askId,
    createdAt: new Date().toISOString(),
    question: request.question,
    sessionFile,
    terminal: null,
    leadTerminal: request.leadTerminal,
    deadline: Date.now() + askDeadlineSeconds * millisecondsPerSecond,
    status: 'running',
    detail: null,
    answer: null,
    gateRecord: request.gateRecord,
  };

  await writeAskRecord(request.root, initial);

  if (request.hc.signal?.aborted === true) {
    await updateHiddenAskRecord(request.root, askId, (current) => ({
      ...current,
      status: 'failed',
      detail: 'The ask was cancelled before its terminal started.',
    }));

    request.hc.signal.throwIfAborted();
  }

  const launched = await launchHiddenRecord(request, initial, recordPath, model, fence, options);

  if (launched.kind === 'settled') {
    return launched.result;
  }

  const { started, terminal } = launched;

  let waited: Awaited<ReturnType<typeof wait>>;

  try {
    waited = await wait(request.hc, terminal, { timeout: askDeadlineSeconds });
  } catch (error) {
    return settleWaitFailure(request, started, fence, terminal, settle, error, options);
  }

  if (!waited.ended) {
    return settleTimeout(request, started, terminal, settle, options);
  }

  return settleEnded(request, askId, waited.exit_code ?? null, waited.signal ?? null, options);
};

export const startHiddenAskRun = (
  request: AskRequest,
  fence: StartFence,
  options: ChangeAskOptions = {},
): HiddenAskRun => {
  const settle = (): Promise<StartFenceCompletion> => fence.complete();

  return {
    settle,
    start: (sessionFile: string, model: string): Promise<AskResult> =>
      runHiddenAsk(request, sessionFile, model, fence, settle, options),
  };
};
