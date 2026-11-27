import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { normalizeCancellation } from '../../../command.js';
import type { ConfigLocation, ConfigWarnings } from '../../../config/config.js';
import { userConfigPath } from '../../../config/config.js';
import { readRoleModel } from '../../../config/roleModels.js';
import { errorMessage, isMissingFile, toError } from '../../../errors.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import type { LiveLockHolder } from '../../../fileLock/fileLock.js';
import { isBareRootWithoutGitEntry } from '../../../git.js';
import { foregroundArgv, get } from '../../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../../hc/hc.js';
import { findPane } from '../../../piStart/herdrPane.js';
import {
  launchPiSession,
  launchPiSessionRightOf,
  StartedTabError,
} from '../../../piStart/piStart.js';
import type { PiLaunchResult } from '../../../piStart/piStart.js';
import { tabName } from '../../../tabName.js';
import { launchOutcomeDecision } from '../claimRelease/launchOutcomeDecision.js';
import { architectLockPath } from '../lock.js';
import type { ArchitectClaimOptions } from '../lock.js';
import { readArchitectRecord, readAskRecords } from '../record.js';
import type { SavedArchitectRecord } from '../record.js';
import { acquireStartFence, startFenceBlockerMessage } from '../startFence/startFence.js';
import type { StartFence, StartFenceBlocker } from '../startFence/startFence.js';
import { eligibleTerminal, openCandidate, openReuse, openTerminal } from './openReuseDecision.js';
import type { OpenCandidate } from './openReuseDecision.js';

export interface OpenRequest {
  root: string;
  leadTerminal: string;
  request: string;
  location: ConfigLocation;
  ui: ConfigWarnings;
  hc: HcRuntime;
}

export type OpenResult =
  | { status: 'opened'; sessionFile: null; model: string }
  | { status: 'running'; terminal: string }
  | { status: 'resumed'; sessionFile: string; model: string };

interface PreparedArchitectStart {
  session: string | undefined;
  task: string;
  model: string;
  pane: string | undefined;
  bareRoot: boolean;
  environment: Record<string, string>;
}

type ReplyTerminal = Parameters<typeof launchOutcomeDecision>[0]['replyTerminal'];

// A kept claim names the token this process reserved and never released. The lead keeps it until
// its session ends, so a later open reports the reservation instead of an in-flight start.
interface KeptClaim {
  token: string;
  failure?: Error;
}

const askLabel = 'tau.architect.ask';

export const takeoverSeconds = 60;
const millisecondsPerSecond = 1000;

const fileExists = (path: string): Promise<boolean> =>
  stat(path).then(
    (stats) => stats.isFile(),
    (error: unknown) => {
      if (isMissingFile(error)) {
        return false;
      }

      throw error;
    },
  );

const ownSliceDesign = async (root: string): Promise<string | undefined> => {
  const path = join(root, '.tau', 'slices', basename(root), 'design.md');

  return (await fileExists(path)) ? path : undefined;
};

const freshTask = async (
  root: string,
  leadTerminal: string,
  userRequest: string,
): Promise<string> => {
  const design = await ownSliceDesign(root);

  const context =
    design === undefined
      ? 'Read AGENTS.md before you design anything.'
      : `Read the slice design: ${design}.`;

  return `You are the architect for ${root}. ${context} The lead terminal is ${leadTerminal}. Talk to the user about design, and end the session with one final handover to ${leadTerminal}, as your guidelines say.\n\nThe user's request:\n${userRequest}`;
};

const resumeTask = (root: string, leadTerminal: string, userRequest: string): string =>
  `Resume the architect session for ${root}. The lead terminal is ${leadTerminal}. The lead opened it for a design conversation with the user.\n\nThe user's request:\n${userRequest}`;

const requireModel = (request: OpenRequest): string => {
  const model = readRoleModel(request.location, 'architect', request.ui);

  if (model === undefined) {
    throw new Error(
      `Set roles.architect.model in ${userConfigPath(request.location.agentDirectory)}.`,
    );
  }

  return model;
};

const readLiveTerminal = async (
  hc: HcRuntime,
  terminal: string | null | undefined,
): Promise<HcTerminal | undefined> => {
  if (terminal === null || terminal === undefined) {
    return undefined;
  }

  const found = await get(hc, terminal).catch(() => undefined);

  return found?.state === 'live' ? found : undefined;
};

const terminalRunsAsk = async (root: string, terminal: string | undefined): Promise<boolean> => {
  if (terminal === undefined) {
    return false;
  }

  const { records } = await readAskRecords(root);

  return records.some(
    (ask) => ask.route === 'hidden' && ask.status === 'running' && ask.terminal === terminal,
  );
};

const readPane = async (request: OpenRequest, terminal: string): Promise<string | undefined> => {
  try {
    return await findPane(request.hc, terminal);
  } catch (error) {
    throw new Error(
      `The architect terminal ${terminal} is live, but its pane could not be read, so it may not be visible: ${errorMessage(error)}`,
      { cause: error },
    );
  }
};

const candidateOf = async (
  request: OpenRequest,
  recordedTerminal: string,
  holder: LiveLockHolder,
): Promise<OpenCandidate> => {
  const found = await readLiveTerminal(request.hc, recordedTerminal);
  const liveTerminal = found === undefined ? undefined : recordedTerminal;

  const runsAsk = await terminalRunsAsk(request.root, liveTerminal);
  const labeledAsk = found?.labels?.[askLabel] !== undefined;
  const eligibility = { liveTerminal, terminalRunsAsk: runsAsk, terminalLabeledAsk: labeledAsk };

  const eligible = eligibleTerminal(eligibility);
  const pane = eligible === undefined ? undefined : await readPane(request, eligible);

  return openCandidate({ holder, ...eligibility, terminalHasPane: pane !== undefined });
};

const readLeadSpace = async (request: OpenRequest): Promise<string | undefined> => {
  const lead = await get(request.hc, request.leadTerminal);

  return lead.labels?.['herdr.space'];
};

const findLeadPane = async (request: OpenRequest): Promise<string> => {
  const pane = await findPane(request.hc, request.leadTerminal);

  if (pane === undefined) {
    throw new Error(`herdr-app shows no pane for the lead terminal ${request.leadTerminal}.`);
  }

  return pane;
};

const hasSpace = (leadSpace: string | undefined): boolean =>
  leadSpace !== undefined && leadSpace !== '';

const prepareArchitectStart = async (
  request: OpenRequest,
  recordedSession: string | undefined,
  claimToken: string,
): Promise<PreparedArchitectStart> => {
  const leadSpace = await readLeadSpace(request);
  const model = requireModel(request);
  const resume = recordedSession !== undefined && (await fileExists(recordedSession));
  const session = resume ? recordedSession : undefined;
  const pane = hasSpace(leadSpace) ? await findLeadPane(request) : undefined;

  const task =
    session === undefined
      ? await freshTask(request.root, request.leadTerminal, request.request)
      : resumeTask(request.root, request.leadTerminal, request.request);

  return {
    session,
    task,
    model,
    pane,
    bareRoot: await isBareRootWithoutGitEntry(request.root),
    environment: {
      TAU_ROLE: 'architect',
      TAU_LEAD_TERMINAL: request.leadTerminal,
      TAU_ARCHITECT_CLAIM: claimToken,
    },
  };
};

const launchArchitect = (
  request: OpenRequest,
  prepared: PreparedArchitectStart,
  fence: StartFence,
): Promise<PiLaunchResult> => {
  const start = {
    folder: request.root,
    task: prepared.task,
    model: prepared.model,
    session: prepared.session,
    bareRoot: prepared.bareRoot,
    environment: prepared.environment,
    readForegroundArgv: (terminal: string, signal: AbortSignal) =>
      foregroundArgv({ ...request.hc, signal }, terminal),
    argvWrapper: (argv: string[]): string[] => fence.wrapArgv(argv),
  };

  if (prepared.pane === undefined) {
    const target = { name: `architect-${basename(request.root)}` };

    const started = launchPiSession(request.hc, {
      ...start,
      target,
      tabName: tabName('architect'),
    });

    return started;
  }

  return launchPiSessionRightOf(request.hc, { ...start, pane: prepared.pane });
};

const keptClaimFailure = (
  completionFailure: Error | undefined,
  readbackFailure: Error | undefined,
): Error | undefined => {
  if (completionFailure === undefined) {
    return readbackFailure;
  }

  if (readbackFailure === undefined) {
    return completionFailure;
  }

  return new Error(`${completionFailure.message} ${readbackFailure.message}`, {
    cause: completionFailure,
  });
};

const replyTerminalOf = (launch: PiLaunchResult): ReplyTerminal =>
  launch.terminal === undefined ? 'malformed' : 'valid';

const launchFacts = (launch: PiLaunchResult): Parameters<typeof launchOutcomeDecision>[0] => ({
  exitCode: launch.exitCode,
  killed: launch.killed,
  aborted: launch.aborted,
  replyTerminal: replyTerminalOf(launch),
});

const launchFailure = (launch: PiLaunchResult): Error =>
  launch.error instanceof Error
    ? launch.error
    : new Error('The architect launch failed before it reported a terminal.');

const launchReportedFailure = (launch: PiLaunchResult): boolean =>
  launchOutcomeDecision(launchFacts(launch)) === 'notCreated';

const launchResult = (prepared: PreparedArchitectStart, model: string): OpenResult =>
  prepared.session === undefined
    ? { status: 'opened', sessionFile: null, model }
    : { status: 'resumed', sessionFile: prepared.session, model };

const refusal = (checkout: string): Error =>
  new Error(`The architect is already running in ${checkout}.`);

export const startingError = (root: string): Error =>
  new Error(`The architect in ${root} is starting. Call architect open again shortly.`);

const blockedStartError = (root: string, blocker: StartFenceBlocker): Error => {
  const message = startFenceBlockerMessage(blocker);

  return message === undefined ? startingError(root) : new Error(message);
};

export const openKeptClaimMessage = (root: string): string =>
  `The architect in ${root} did not take the checkout lock, so the checkout stays reserved until this lead session exits. Stop the started terminal, or end this lead session, before calling architect open again.`;

const openKeptClaimError = (root: string, failure: Error | undefined): Error => {
  const message = openKeptClaimMessage(root);

  return failure === undefined
    ? new Error(message)
    : new Error(`${message} ${failure.message}`, { cause: failure });
};

const keptClaims = new Map<string, KeptClaim>();

export const takeoverExpiryError = (): Error =>
  new Error(
    `The architect did not take the checkout lock within ${takeoverSeconds} seconds. Call architect open again.`,
  );

export const takeoverChildGoneError = (): Error =>
  new Error(
    'The architect launch ended before it took the checkout lock. Call architect open again.',
  );

export const takeoverAdoptedChildEndedError = (): Error =>
  new Error(
    'The architect took the checkout lock but its process ended before it could answer. Call architect open again.',
  );

const cancelledOpenError = (signal: AbortSignal | undefined): Error =>
  toError(normalizeCancellation(signal, signal?.reason, 'The open was cancelled.'));

const throwIfOpenCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw cancelledOpenError(signal);
  }
};

// The launch's checkout probe reports piStart's own cancellation message, so report the caller's
// cancellation instead.
const launchArchitectForOpen = async (
  request: OpenRequest,
  prepared: PreparedArchitectStart,
  fence: StartFence,
): Promise<PiLaunchResult> => {
  try {
    return await launchArchitect(request, prepared, fence);
  } catch (error) {
    throwIfOpenCancelled(request.hc.signal);

    throw error;
  }
};

const waitForTakeover = async (
  fence: StartFence,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const deadline = Date.now() + takeoverSeconds * millisecondsPerSecond;
  const takeover = await fence.waitForTakeover(deadline, signal);

  if (takeover === 'cancelled') {
    throw cancelledOpenError(signal);
  }

  if (takeover === 'expired') {
    throw takeoverExpiryError();
  }

  if (takeover === 'gone') {
    throw takeoverChildGoneError();
  }
};

const runningTerminal = async (
  request: OpenRequest,
  record: SavedArchitectRecord | undefined,
): Promise<string | undefined> => {
  const lockPath = architectLockPath(request.root);
  const holder = await readLiveLockHolder(lockPath);

  if (holder === undefined) {
    keptClaims.delete(request.root);

    return undefined;
  }

  const selection = openTerminal({
    root: request.root,
    holder,
    record,
    keptClaim: keptClaims.get(request.root)?.token === holder.token,
  });

  if (selection.kind === 'refuse') {
    throw refusal(selection.checkout);
  }

  if (selection.kind === 'keptClaim') {
    throw openKeptClaimError(request.root, keptClaims.get(request.root)?.failure);
  }

  if (selection.kind === 'starting') {
    throw startingError(request.root);
  }

  const candidate = await candidateOf(request, selection.terminal, holder);

  if (candidate.kind === 'refuse') {
    throw refusal(candidate.checkout);
  }

  if (candidate.kind === 'parked') {
    throw new Error(candidate.message);
  }

  const currentHolder = await readLiveLockHolder(lockPath);
  const reuse = openReuse({ holder, currentHolder, terminal: candidate.terminal });

  if (reuse.kind === 'refuse') {
    throw refusal(reuse.checkout);
  }

  return reuse.kind === 'reuse' ? reuse.terminal : undefined;
};

const settleLaunch = async (
  request: OpenRequest,
  fence: StartFence,
  failure: Error,
): Promise<void> => {
  const completion = await fence.complete();

  throwIfOpenCancelled(request.hc.signal);

  if (completion.outcome === 'adopted') {
    return;
  }

  if (completion.outcome === 'unresolved' || completion.claim === 'kept') {
    throw openKeptClaimError(request.root, completion.failure);
  }

  throw failure;
};

const adoptionReadError = (error: unknown): Error =>
  new Error(`The child adoption could not be read: ${errorMessage(error)}`, { cause: error });

const applyLaunchOutcome = async (
  request: OpenRequest,
  fence: StartFence,
  started: PiLaunchResult,
): Promise<void> => {
  // A readback failure leaves a live terminal, and an adopted child keeps running. The caller must
  // still see the failure, so the outer catch completes the fence and reports it. An abort reports
  // the caller's cancellation error instead of the readback error.
  if (started.error instanceof StartedTabError) {
    throwIfOpenCancelled(request.hc.signal);

    throw launchFailure(started);
  }

  if (launchReportedFailure(started)) {
    await settleLaunch(request, fence, launchFailure(started));

    return;
  }

  let waitFailure: Error | undefined;

  try {
    await fence.recordStarted();
  } catch (error) {
    waitFailure = adoptionReadError(error);
  }

  if (waitFailure === undefined) {
    try {
      await waitForTakeover(fence, request.hc.signal);
    } catch (error) {
      waitFailure = toError(error);
    }
  }

  await settleLaunch(request, fence, waitFailure ?? takeoverAdoptedChildEndedError());
};

export const openArchitect = async (
  request: OpenRequest,
  claimOptions: ArchitectClaimOptions = {},
): Promise<OpenResult> => {
  const record = await readArchitectRecord(request.root);
  const running = await runningTerminal(request, record);

  if (running !== undefined) {
    return { status: 'running', terminal: running };
  }

  const acquisition = await acquireStartFence(request.root, claimOptions);

  if (acquisition.kind === 'refused') {
    throw startingError(request.root);
  }

  if (acquisition.kind === 'blocked') {
    throw blockedStartError(request.root, acquisition.blocker);
  }

  const fence = acquisition.fence;

  try {
    await fence.createTicket();

    const prepared = await prepareArchitectStart(
      request,
      record?.sessionFile ?? undefined,
      fence.token,
    );

    throwIfOpenCancelled(request.hc.signal);

    const started = await launchArchitectForOpen(request, prepared, fence);

    await applyLaunchOutcome(request, fence, started);

    const result = launchResult(prepared, started.model ?? 'unknown');

    keptClaims.delete(request.root);

    return result;
  } catch (error) {
    const completion = await fence.complete();

    if (completion.claim === 'kept') {
      // A readback failure is the only error that names the started terminal and its model, so it
      // survives the kept-claim message and a later open.
      const readbackFailure = error instanceof StartedTabError ? error : undefined;
      const failure = keptClaimFailure(completion.failure, readbackFailure);

      keptClaims.set(request.root, {
        token: fence.token,
        ...(failure === undefined ? {} : { failure }),
      });

      throw openKeptClaimError(request.root, failure);
    }

    throw error;
  }
};
