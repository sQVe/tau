import { randomUUID } from 'node:crypto';

import type { ConfigLocation, ConfigWarnings } from '../../../config/config.js';
import { notifyOnce, userConfigPath } from '../../../config/config.js';
import { readRoleModel } from '../../../config/roleModels.js';
import { errorMessage } from '../../../errors.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { get, kill, run, wait } from '../../../hc/hc.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { piArguments } from '../../../piStart/piArguments.js';
import { launchTimeoutMilliseconds } from '../../../piStart/piStart.js';
import { processState } from '../../../process/process.js';
import { releaseClaim } from '../claimRelease/claimRelease.js';
import type { ClaimReleaseFacts } from '../claimRelease/claimReleaseDecision.js';
import { launchOutcomeDecision } from '../claimRelease/launchOutcomeDecision.js';
import type { LaunchOutcome } from '../claimRelease/launchOutcomeDecision.js';
import type { LiveAskResult, StartLiveAsk } from '../liveAsk.js';
import { architectLockPath, claimArchitectLock } from '../lock.js';
import type { ArchitectClaimOptions } from '../lock.js';
import {
  askRecordPath,
  changeAskRecord,
  readArchitectRecord,
  readAskRecords,
  writeAskRecord,
} from '../record.js';
import type {
  AskRecordGap,
  ChangeAskOptions,
  HiddenAskRecord,
  SavedArchitectRecord,
} from '../record.js';
import {
  cancelStartTicket,
  createStartTicket,
  deleteStartMarker,
  malformedStartMarkerReason,
  readStartMarker,
  startHeldByProcessReason,
  sweepStartFolder,
  wrapStartArgv,
} from '../startTicket/startTicket.js';
import type { StartSweepResult } from '../startTicket/startTicket.js';
import { askRecordOutcome, askRoute, askTransition, staleAskRepair } from './askDecision.js';
import type { ArchitectPublication } from './askDecision.js';

export interface AskRequest {
  root: string;
  question: string;
  gateRecord: string | null;
  leadTerminal: string;
  leadSessionId: string;
  listenerPath: string | undefined;
  location: ConfigLocation;
  ui: ConfigWarnings;
  hc: HcRuntime;
  liveAsk: StartLiveAsk;
}

export type AskResult =
  | LiveAskResult
  | { status: 'ended'; askId: string; answer: string }
  | { status: 'failed'; askId: string; reason: string };

interface HiddenAskClaim {
  ticket: ClaimReleaseFacts['ticket'];
  terminal: string | undefined;
  processId: number | undefined;
  child: ClaimReleaseFacts['child'];
  stopAttempted: boolean;
  settled: boolean;
  kept: boolean;
}

interface HiddenAskLaunch {
  outcome: LaunchOutcome;
  terminal: string | undefined;
  error: unknown;
}

type SettleHiddenAskClaim = () => Promise<boolean>;

export const askDeadlineSeconds = 900;

export const askStartingReason = 'The architect is starting. Ask again shortly.';

export const askKeptClaimMessage = (root: string): string =>
  `The architect in ${root} did not take the checkout lock, so the checkout stays reserved until this lead session exits. Stop the started terminal, or end this lead session, before calling architect ask again.`;

export const askUnconfirmedStopDetail =
  'The ask terminal did not confirm that it stopped. The ask ends at its deadline.';

export const askLaunchFailureDetail = 'The ask terminal could not be started.';

export const askWaitFailureDetail = (cancelled: boolean, error: unknown): string =>
  `The ask wait was ${cancelled ? 'cancelled' : 'failed'}: ${errorMessage(error)}`;

const askDeadlineReason =
  'The ask reached its deadline. Call architect open to talk to the architect.';

const askEndedReason =
  'The architect ended without sending an answer. Call architect open to talk to it.';

const askFailedReason =
  'The ask terminal failed before the architect answered. Call architect open instead.';

const millisecondsPerSecond = 1000;

const reportAskGaps = (ui: ConfigWarnings, gaps: AskRecordGap[]): void => {
  for (const gap of gaps) {
    notifyOnce(ui, gap.path, 'ask-record', gap.reason, 'warning');
  }
};

const changeHiddenAsk = (
  root: string,
  askId: string,
  change: (current: HiddenAskRecord) => HiddenAskRecord | undefined,
  options: ChangeAskOptions = {},
) =>
  changeAskRecord(
    root,
    askId,
    (current) => {
      if (current.route !== 'hidden') {
        return undefined;
      }

      const next = change(current);

      if (next === undefined) {
        return undefined;
      }

      return askTransition({ current: current.status, next: next.status }) === 'allowed'
        ? next
        : undefined;
    },
    options,
  );

const liveRunningAsk = async (
  root: string,
  hc: HcRuntime,
  ui: ConfigWarnings,
): Promise<HiddenAskRecord | undefined> => {
  const { records, gaps } = await readAskRecords(root);

  reportAskGaps(ui, gaps);

  const newest = records.findLast((record): record is HiddenAskRecord => record.route === 'hidden');

  if (newest?.status !== 'running' || newest.terminal === null) {
    return undefined;
  }

  const terminal = await get(hc, newest.terminal).catch(() => undefined);

  if (terminal === undefined) {
    return undefined;
  }

  const terminalState = terminal.state === 'live' ? 'live' : 'ended';

  const repair = staleAskRepair({
    status: newest.status,
    terminalState,
    recordTerminal: newest.terminal,
    endedTerminal: terminal.address,
  });

  if (repair === 'repair') {
    await changeHiddenAsk(root, newest.askId, (current) =>
      current.status === 'running'
        ? {
            ...current,
            status: 'failed',
            detail: 'The ask terminal ended without settling the ask.',
          }
        : undefined,
    );

    return undefined;
  }

  return terminal.state === 'live' ? newest : undefined;
};

const requireModel = (request: AskRequest): string => {
  const model = readRoleModel(request.location, 'architect', request.ui);

  if (model === undefined) {
    throw new Error(
      `Set roles.architect.model in ${userConfigPath(request.location.agentDirectory)}.`,
    );
  }

  return model;
};

const needsOpen = (reason: string): AskResult => ({ status: 'needsOpen', reason });

const hiddenAskLaunch = async (
  request: AskRequest,
  initial: HiddenAskRecord,
  recordPath: string,
  model: string,
  claimToken: string,
  ticketPath: string,
): Promise<HiddenAskLaunch> => {
  const hc = { ...request.hc, signal: undefined };

  try {
    const terminal = await run(hc, {
      argv: wrapStartArgv(
        ticketPath,
        piArguments({
          model,
          session: initial.sessionFile,
          environment: {
            TAU_ROLE: 'architect',
            TAU_ARCHITECT_ASK: recordPath,
            TAU_LEAD_TERMINAL: request.leadTerminal,
            TAU_ARCHITECT_CLAIM: claimToken,
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

const readLaunchedProcess = async (
  root: string,
  claimToken: string,
): Promise<Pick<HiddenAskClaim, 'processId' | 'child'>> => {
  const marker = await readStartMarker(root, claimToken);

  return marker?.kind === 'process'
    ? { processId: marker.pid, child: 'running' }
    : { processId: undefined, child: 'unknown' };
};

const claimTakenOver = async (root: string, claimToken: string): Promise<boolean> => {
  const holder = await readLiveLockHolder(architectLockPath(root));

  return holder !== undefined && holder.token !== claimToken;
};

const stopAskTerminal = async (request: AskRequest, state: HiddenAskClaim): Promise<void> => {
  if (state.terminal !== undefined) {
    await kill({ ...request.hc, signal: undefined }, state.terminal).catch(() => undefined);
  }

  state.child = state.processId === undefined ? 'unknown' : processState(state.processId);
  state.stopAttempted = true;
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
  state: HiddenAskClaim,
  settle: SettleHiddenAskClaim,
  error: unknown,
): Promise<never> => {
  const cancelled = request.hc.signal?.aborted === true;

  await stopAskTerminal(request, state);

  const kept = await settle();

  if (kept) {
    await changeHiddenAsk(request.root, started.askId, (current) => ({
      ...current,
      status: 'running',
      detail: askUnconfirmedStopDetail,
    }));

    throw new Error(askKeptClaimMessage(request.root));
  }

  await changeHiddenAsk(request.root, started.askId, (current) => ({
    ...current,
    status: 'failed',
    detail: askWaitFailureDetail(cancelled, error),
  }));

  throw error;
};

const settleTimeout = async (
  request: AskRequest,
  started: HiddenAskRecord,
  state: HiddenAskClaim,
  settle: SettleHiddenAskClaim,
): Promise<AskResult> => {
  await stopAskTerminal(request, state);

  const kept = await settle();
  const status = kept ? 'running' : 'timeout';

  const detail = kept
    ? askUnconfirmedStopDetail
    : 'The ask reached its deadline before the architect answered.';

  const changed = await changeHiddenAsk(request.root, started.askId, (current) => ({
    ...current,
    status,
    detail,
  }));

  const current = changed?.record;
  const record = current?.route === 'hidden' ? current : undefined;

  if (record?.status === 'running') {
    return needsOpen(askKeptClaimMessage(request.root));
  }

  return resultFromRecord(request.root, started.askId, record);
};

const abandonAskTicket = async (state: HiddenAskClaim, ticketPath: string): Promise<void> => {
  if (state.ticket !== 'notCreated') {
    return;
  }

  state.ticket = await cancelStartTicket(ticketPath);
};

const launchHiddenRecord = async (
  request: AskRequest,
  initial: HiddenAskRecord,
  recordPath: string,
  model: string,
  claimToken: string,
  ticketPath: string,
  state: HiddenAskClaim,
): Promise<{ started: HiddenAskRecord; terminal: string }> => {
  const launched = await hiddenAskLaunch(
    request,
    initial,
    recordPath,
    model,
    claimToken,
    ticketPath,
  );

  if (launched.outcome === 'created' && launched.terminal !== undefined) {
    state.ticket = 'taken';
    state.terminal = launched.terminal;
    Object.assign(state, await readLaunchedProcess(request.root, claimToken));

    const started: HiddenAskRecord = { ...initial, terminal: launched.terminal };

    await changeHiddenAsk(request.root, initial.askId, (current) => ({
      ...current,
      terminal: launched.terminal ?? null,
    }));

    return { started, terminal: launched.terminal };
  }

  await abandonAskTicket(state, ticketPath);

  if (state.ticket === 'taken') {
    Object.assign(state, await readLaunchedProcess(request.root, claimToken));
    state.stopAttempted = false;

    if (await claimTakenOver(request.root, claimToken)) {
      state.child = 'running';
      state.stopAttempted = true;
    }
  }

  await changeHiddenAsk(request.root, initial.askId, (current) => ({
    ...current,
    status: 'failed',
    detail: askLaunchFailureDetail,
  }));

  throw launched.error;
};

const runHiddenAsk = async (
  request: AskRequest,
  sessionFile: string,
  model: string,
  claimToken: string,
  ticketPath: string,
  state: HiddenAskClaim,
  settle: SettleHiddenAskClaim,
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
    await changeHiddenAsk(request.root, askId, (current) => ({
      ...current,
      status: 'failed',
      detail: 'The ask was cancelled before its terminal started.',
    }));

    request.hc.signal.throwIfAborted();
  }

  const { started, terminal } = await launchHiddenRecord(
    request,
    initial,
    recordPath,
    model,
    claimToken,
    ticketPath,
    state,
  );

  let waited: Awaited<ReturnType<typeof wait>>;

  try {
    waited = await wait(request.hc, terminal, { timeout: askDeadlineSeconds });
  } catch (error) {
    return settleWaitFailure(request, started, state, settle, error);
  }

  if (!waited.ended) {
    return settleTimeout(request, started, state, settle);
  }

  state.child = state.processId === undefined ? 'unknown' : processState(state.processId);
  state.stopAttempted = true;

  const changed = await changeHiddenAsk(request.root, askId, (current) =>
    current.status === 'running'
      ? {
          ...current,
          status: 'failed',
          detail: 'The ask ended without sending an answer.',
        }
      : undefined,
  );

  if (changed?.changed === true) {
    return needsOpen(askEndedReason);
  }

  const current = changed?.record;
  const record = current?.route === 'hidden' ? current : undefined;

  return resultFromRecord(request.root, askId, record);
};

const sweepRefusal = (sweep: Exclude<StartSweepResult, { kind: 'clear' }>): string | undefined => {
  if (sweep.kind === 'refuseRunning') {
    return startHeldByProcessReason(sweep.processId);
  }

  return sweep.kind === 'refuseMalformed' ? malformedStartMarkerReason(sweep.path) : undefined;
};

const askHiddenArchitect = async (
  request: AskRequest,
  sessionFile: string,
  claimOptions: ArchitectClaimOptions,
): Promise<AskResult> => {
  const model = requireModel(request);
  const claim = await claimArchitectLock(request.root, claimOptions);

  if (claim.kind === 'refused') {
    return needsOpen(askStartingReason);
  }

  const state: HiddenAskClaim = {
    ticket: 'notCreated',
    terminal: undefined,
    processId: undefined,
    child: 'unknown',
    stopAttempted: false,
    settled: false,
    kept: false,
  };

  let settle: SettleHiddenAskClaim | undefined;

  try {
    const sweep = await sweepStartFolder({
      root: request.root,
      currentToken: claim.token,
    });

    const reason = sweep.kind === 'clear' ? undefined : sweepRefusal(sweep);

    if (sweep.kind !== 'clear') {
      state.settled = true;
      await claim.release();

      return needsOpen(reason ?? askStartingReason);
    }

    const ticketPath = await createStartTicket(request.root, claim.token);

    const settleClaim = async (): Promise<boolean> => {
      if (state.settled) {
        return state.kept;
      }

      state.settled = true;

      if (state.ticket === 'notCreated') {
        state.ticket = await cancelStartTicket(ticketPath);
      }

      const released = await releaseClaim({
        claim,
        ticket: state.ticket,
        adopted: false,
        child: state.child,
        processId: state.processId,
        stopAttempted: state.stopAttempted,
      });

      state.kept = released.kept;

      const gone = !released.kept && state.ticket === 'taken' && released.child === 'gone';

      if (gone && state.processId !== undefined) {
        await deleteStartMarker(request.root, claim.token, state.processId).catch(() => undefined);
      }

      return state.kept;
    };

    settle = settleClaim;

    await claimOptions.beforeDispatch?.();

    return await runHiddenAsk(
      request,
      sessionFile,
      model,
      claim.token,
      ticketPath,
      state,
      settleClaim,
    );
  } finally {
    if (settle === undefined) {
      if (!state.settled) {
        state.settled = true;
        await claim.release();
      }
    } else {
      await settle();
    }
  }
};

const architectPublication = (
  architect: SavedArchitectRecord | undefined,
): ArchitectPublication => {
  if (architect === undefined) {
    return { kind: 'none' };
  }

  if (architect.version === 1) {
    return { kind: 'version1', updatedAt: Date.parse(architect.updatedAt) };
  }

  return architect.owner === null ? { kind: 'none' } : { kind: 'owner', owner: architect.owner };
};

export const askArchitect = async (
  request: AskRequest,
  claimOptions: ArchitectClaimOptions = {},
): Promise<AskResult> => {
  const running = await liveRunningAsk(request.root, request.hc, request.ui);

  if (running !== undefined) {
    return needsOpen(`Ask ${running.askId} is still running. Wait for it to answer.`);
  }

  const architect = await readArchitectRecord(request.root);
  const holder = await readLiveLockHolder(architectLockPath(request.root));

  const holderFacts =
    holder === undefined
      ? undefined
      : { checkout: holder.checkout, token: holder.token, startedAt: Date.parse(holder.startedAt) };

  const route = askRoute({
    root: request.root,
    holder: holderFacts,
    publication: architectPublication(architect),
    sessionFile: architect?.sessionFile ?? null,
  });

  if (route.kind === 'needsOpen') {
    return needsOpen(route.reason);
  }

  if (route.kind === 'live') {
    return request.liveAsk(request, route);
  }

  return askHiddenArchitect(request, route.sessionFile, claimOptions);
};
