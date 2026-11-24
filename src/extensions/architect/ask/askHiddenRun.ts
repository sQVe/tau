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
import type { ChangeAskOptions, HiddenAskRecord } from '../record.js';
import type { StartFence } from '../startFence/startFence.js';
import type { AskRequest, AskResult } from './ask.js';
import { askRecordOutcome } from './askDecision.js';

interface HiddenAskStop {
  terminal: string | undefined;
  stopAttempted: boolean;
}

interface HiddenAskLaunch {
  outcome: LaunchOutcome;
  terminal: string | undefined;
  error: unknown;
}

type SettleHiddenAskClaim = () => Promise<HiddenAskSettlement>;

type HiddenAskSettlement = 'kept' | 'adopted' | 'released';

export interface HiddenAskRun {
  start: (sessionFile: string, model: string) => Promise<AskResult>;
  settle: () => Promise<HiddenAskSettlement>;
}

type HiddenAskLaunchResult =
  | { kind: 'started'; started: HiddenAskRecord; terminal: string }
  | { kind: 'adopted'; started: HiddenAskRecord };

export const askDeadlineSeconds = 900;

export const askKeptClaimMessage = (root: string): string =>
  `The architect in ${root} did not take the checkout lock, so the checkout stays reserved until this lead session exits. Stop the started terminal, or end this lead session, before calling architect ask again.`;

export const askUnconfirmedStopDetail =
  'The ask terminal did not confirm that it stopped. The ask ends at its deadline.';

export const askUnconfirmedStopReason =
  'The ask still runs because its terminal did not confirm that it stopped. The ask ends at its deadline.';

export const askLaunchFailureDetail = 'The ask terminal could not be started.';

export const askWaitFailureDetail = (cancelled: boolean, error: unknown): string =>
  `The ask wait was ${cancelled ? 'cancelled' : 'failed'}: ${errorMessage(error)}`;

export const askAdoptedChildStoppedDetail =
  'The ask wait ended when its adopted child stopped before the architect answered.';

const askDeadlineReason =
  'The ask reached its deadline. Call architect open to talk to the architect.';

const askEndedReason =
  'The architect ended without sending an answer. Call architect open to talk to it.';

const askEndedDetail = 'The ask ended without sending an answer.';

const askEndedFailureDetail = 'The ask terminal failed before the architect answered.';

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
      timeout: launchTimeoutMilliseconds,
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

const terminalStopped = async (
  request: AskRequest,
  terminal: string | undefined,
): Promise<boolean> => {
  if (terminal === undefined) {
    return false;
  }

  return kill({ ...request.hc, signal: undefined }, terminal).then(
    (reply) => reply.state !== 'live',
    () => false,
  );
};

const stopAskTerminal = async (
  request: AskRequest,
  fence: StartFence,
  stop: HiddenAskStop,
): Promise<void> => {
  const stopped = await terminalStopped(request, stop.terminal);

  await fence.refreshChild();
  stop.stopAttempted = stopped;
};

const resultFromRecord = (
  root: string,
  askId: string,
  record: HiddenAskRecord | undefined,
): AskResult => {
  if (record === undefined) {
    return needsOpen(askKeptClaimMessage(root));
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

  return needsOpen(askKeptClaimMessage(root));
};

const settleWaitFailure = async (
  request: AskRequest,
  started: HiddenAskRecord,
  fence: StartFence,
  stop: HiddenAskStop,
  settle: SettleHiddenAskClaim,
  error: unknown,
  options: ChangeAskOptions,
): Promise<never> => {
  const cancelled = request.hc.signal?.aborted === true;

  await stopAskTerminal(request, fence, stop);

  const settled = await settle();

  if (settled !== 'released') {
    await updateHiddenAskRecord(
      request.root,
      started.askId,
      (current) => ({
        ...current,
        status: 'running',
        detail: askUnconfirmedStopDetail,
      }),
      options,
    );
  }

  if (settled === 'kept') {
    throw new Error(askKeptClaimMessage(request.root));
  }

  if (settled === 'adopted') {
    throw error;
  }

  await updateHiddenAskRecord(
    request.root,
    started.askId,
    (current) => ({
      ...current,
      status: 'failed',
      detail: askWaitFailureDetail(cancelled, error),
    }),
    options,
  );

  throw error;
};

const settleTimeout = async (
  request: AskRequest,
  started: HiddenAskRecord,
  fence: StartFence,
  stop: HiddenAskStop,
  settle: SettleHiddenAskClaim,
  options: ChangeAskOptions,
): Promise<AskResult> => {
  await stopAskTerminal(request, fence, stop);

  const settled = await settle();
  const unconfirmed = settled !== 'released';
  const status = unconfirmed ? 'running' : 'timeout';

  const detail = unconfirmed
    ? askUnconfirmedStopDetail
    : 'The ask reached its deadline before the architect answered.';

  const changed = await updateHiddenAskRecord(
    request.root,
    started.askId,
    (current) => ({
      ...current,
      status,
      detail,
    }),
    options,
  );

  const record = changed?.record;

  if (record?.status === 'running') {
    const reason =
      settled === 'kept' ? askKeptClaimMessage(request.root) : askUnconfirmedStopReason;

    return needsOpen(reason);
  }

  return resultFromRecord(request.root, started.askId, record);
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

const launchHiddenRecord = async (
  request: AskRequest,
  initial: HiddenAskRecord,
  recordPath: string,
  model: string,
  fence: StartFence,
  stop: HiddenAskStop,
): Promise<HiddenAskLaunchResult> => {
  const launched = await hiddenAskLaunch(request, initial, recordPath, model, fence);

  await fence.recordStarted();

  if (launched.outcome === 'created' && launched.terminal !== undefined) {
    stop.terminal = launched.terminal;

    const started: HiddenAskRecord = { ...initial, terminal: launched.terminal };

    await updateHiddenAskRecord(request.root, initial.askId, (current) => ({
      ...current,
      terminal: launched.terminal ?? null,
    }));

    return { kind: 'started', started, terminal: launched.terminal };
  }

  if (await fence.childAdopted()) {
    return { kind: 'adopted', started: initial };
  }

  const abandoned = await fence.abandon();

  if (abandoned.adopted) {
    return { kind: 'adopted', started: initial };
  }

  await updateHiddenAskRecord(request.root, initial.askId, (current) => ({
    ...current,
    status: 'failed',
    detail: askLaunchFailureDetail,
  }));

  throw launched.error;
};

const settleEnded = async (
  request: AskRequest,
  askId: string,
  exitCode: number | null,
  options: ChangeAskOptions,
): Promise<AskResult> => {
  const failed = exitCode !== 0;
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
  stop: HiddenAskStop,
  settle: SettleHiddenAskClaim,
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

  const launched = await launchHiddenRecord(request, initial, recordPath, model, fence, stop);

  if (launched.kind === 'adopted') {
    const childGone = await waitForAdoptedChild(launched.started, fence, request.hc.signal);

    const changed = await updateHiddenAskRecord(
      request.root,
      askId,
      (current) =>
        childGone
          ? { ...current, status: 'failed', detail: askAdoptedChildStoppedDetail }
          : undefined,
      options,
    );

    request.hc.signal?.throwIfAborted();

    return resultFromRecord(request.root, askId, changed?.record);
  }

  const { started, terminal } = launched;

  let waited: Awaited<ReturnType<typeof wait>>;

  try {
    waited = await wait(request.hc, terminal, { timeout: askDeadlineSeconds });
  } catch (error) {
    return settleWaitFailure(request, started, fence, stop, settle, error, options);
  }

  if (!waited.ended) {
    return settleTimeout(request, started, fence, stop, settle, options);
  }

  await fence.refreshChild();
  stop.stopAttempted = true;

  return settleEnded(request, askId, waited.exit_code ?? null, options);
};

export const startHiddenAskRun = (
  request: AskRequest,
  fence: StartFence,
  options: ChangeAskOptions = {},
): HiddenAskRun => {
  const stop: HiddenAskStop = { terminal: undefined, stopAttempted: false };

  const settle = async (): Promise<HiddenAskSettlement> => {
    const abandoned = await fence.abandon();

    if (abandoned.adopted) {
      stop.stopAttempted = true;
    }

    const finished = await fence.finish({
      adopted: abandoned.adopted,
      stopAttempted: stop.stopAttempted,
    });

    if (finished.kept) {
      return 'kept';
    }

    if (abandoned.adopted && (await fence.refreshChild()) !== 'gone') {
      return 'adopted';
    }

    return 'released';
  };

  return {
    settle,
    start: (sessionFile: string, model: string): Promise<AskResult> =>
      runHiddenAsk(request, sessionFile, model, fence, stop, settle, options),
  };
};
