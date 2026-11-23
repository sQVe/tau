import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ConfigLocation, ConfigWarnings } from '../../../config/config.js';
import { userConfigPath } from '../../../config/config.js';
import { readRoleModel } from '../../../config/roleModels.js';
import { errorMessage, isMissingFile } from '../../../errors.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import type { LiveLockHolder } from '../../../fileLock/fileLock.js';
import { isBareRootWithoutGitEntry } from '../../../git.js';
import { get } from '../../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../../hc/hc.js';
import { findPane } from '../../../piStart/herdrPane.js';
import { launchPiSession, launchPiSessionRightOf } from '../../../piStart/piStart.js';
import type { PiLaunchResult } from '../../../piStart/piStart.js';
import { tabName } from '../../../tabName.js';
import { releaseClaim } from '../claimRelease/claimRelease.js';
import type { ClaimReleaseFacts } from '../claimRelease/claimReleaseDecision.js';
import { launchLookup, lookupLaunchTerminal } from '../claimRelease/launchLookup.js';
import { launchOutcomeDecision } from '../claimRelease/launchOutcomeDecision.js';
import { architectLockPath, claimArchitectLock } from '../lock.js';
import type { ArchitectClaimOptions } from '../lock.js';
import { readArchitectRecord, readAskRecords } from '../record.js';
import type { SavedArchitectRecord } from '../record.js';
import {
  cancelStartTicket,
  createStartTicket,
  deleteStartMarker,
  sweepStartFolder,
  wrapStartArgv,
} from '../startTicket/startTicket.js';
import type { StartTicketTerminal } from '../startTicket/startTicketDecision.js';
import { eligibleTerminal, openCandidate, openReuse, openTerminal } from './openReuseDecision.js';
import type { OpenCandidate } from './openReuseDecision.js';
import { openStartProgress } from './openStartClaimDecision.js';

export interface OpenRequest {
  root: string;
  leadTerminal: string;
  request: string;
  location: ConfigLocation;
  ui: ConfigWarnings;
  hc: HcRuntime;
}

export type OpenResult =
  | { status: 'opened'; sessionFile: null }
  | { status: 'running'; terminal: string }
  | { status: 'resumed'; sessionFile: string };

interface PreparedArchitectStart {
  session: string | undefined;
  task: string;
  model: string;
  pane: string | undefined;
  bareRoot: boolean;
  environment: Record<string, string>;
}

type ReplyTerminal = Parameters<typeof launchOutcomeDecision>[0]['replyTerminal'];

interface LaunchState {
  ticket: ClaimReleaseFacts['ticket'];
  ticketPath: string | undefined;
  terminal: string | undefined;
  terminalState: ClaimReleaseFacts['terminal'];
  adopted: boolean;
}

const askLabel = 'tau.architect.ask';

const takeoverSeconds = 60;
const takeoverPollMilliseconds = 250;
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
  hc: HcRuntime,
  request: OpenRequest,
  prepared: PreparedArchitectStart,
  ticket: string,
): Promise<PiLaunchResult> => {
  const start = {
    folder: request.root,
    task: prepared.task,
    model: prepared.model,
    session: prepared.session,
    bareRoot: prepared.bareRoot,
    environment: prepared.environment,
    argvWrapper: (argv: string[]): string[] => wrapStartArgv(ticket, argv),
  };

  if (prepared.pane === undefined) {
    const target = { name: `architect-${basename(request.root)}` };
    const started = launchPiSession(hc, { ...start, target, tabName: tabName('architect') });

    return started;
  }

  return launchPiSessionRightOf(hc, { ...start, pane: prepared.pane });
};

const replyTerminalOf = (launch: PiLaunchResult): ReplyTerminal =>
  launch.terminal === undefined ? 'malformed' : 'valid';

const launchFacts = (launch: PiLaunchResult): Parameters<typeof launchOutcomeDecision>[0] => ({
  exitCode: launch.exitCode,
  killed: launch.killed,
  aborted: launch.aborted,
  timedOut: launch.timedOut,
  replyTerminal: replyTerminalOf(launch),
});

const launchFailure = (launch: PiLaunchResult): Error =>
  launch.error instanceof Error
    ? launch.error
    : new Error('The architect launch failed before it reported a terminal.');

const launchResult = (prepared: PreparedArchitectStart): OpenResult =>
  prepared.session === undefined
    ? { status: 'opened', sessionFile: null }
    : { status: 'resumed', sessionFile: prepared.session };

const claimTakenOver = async (root: string, claimToken: string): Promise<boolean> => {
  const holder = await readLiveLockHolder(architectLockPath(root));

  return holder !== undefined && holder.token !== claimToken;
};

const recoverTakenTicket = async (
  request: OpenRequest,
  claimToken: string,
  launchHc: HcRuntime,
  started: PiLaunchResult,
  state: LaunchState,
): Promise<void> => {
  const lookup = await launchLookup({ kind: 'open', identifier: claimToken, hc: launchHc });

  if (lookup.kind === 'found') {
    state.terminal = lookup.terminal;
    state.terminalState = 'live';
    state.adopted = await claimTakenOver(request.root, claimToken);

    if (state.adopted) {
      return;
    }
  } else {
    state.terminalState = lookup.kind === 'absent' ? 'absent' : 'unknown';
  }

  throw launchFailure(started);
};

const refusal = (checkout: string): Error =>
  new Error(`The architect is already running in ${checkout}.`);

export const startingError = (root: string): Error =>
  new Error(`The architect in ${root} is starting. Call architect open again shortly.`);

export const openKeptClaimMessage = (root: string): string =>
  `The architect in ${root} did not take the checkout lock, so the checkout stays reserved until this lead session exits. Stop the started terminal, or end this lead session, before calling architect open again.`;

const openKeptClaimError = (root: string): Error => new Error(openKeptClaimMessage(root));

export const takeoverExpiryError = (): Error =>
  new Error(
    `The architect did not take the checkout lock within ${takeoverSeconds} seconds. Call architect open again.`,
  );

const waitForTakeover = async (
  root: string,
  claimToken: string,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const lockPath = architectLockPath(root);
  const deadline = Date.now() + takeoverSeconds * millisecondsPerSecond;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Each poll depends on the previous one.
    const holder = await readLiveLockHolder(lockPath);

    const progress = openStartProgress({
      claimToken,
      holderToken: holder?.token,
      now: Date.now(),
      deadline,
      cancelled: signal?.aborted === true,
    });

    if (progress === 'taken') {
      return;
    }

    if (progress === 'cancelled') {
      signal?.throwIfAborted();

      throw new Error('The open was cancelled.');
    }

    if (progress === 'expired') {
      throw takeoverExpiryError();
    }

    const sleepOptions = signal === undefined ? {} : { signal };

    try {
      // oxlint-disable-next-line no-await-in-loop -- Each poll depends on the previous one.
      await sleep(takeoverPollMilliseconds, undefined, sleepOptions);
    } catch {
      signal?.throwIfAborted();

      throw new Error('The open was cancelled.');
    }
  }
};

const abandonTicket = async (state: LaunchState): Promise<void> => {
  if (state.ticket !== 'notCreated' || state.ticketPath === undefined) {
    return;
  }

  state.ticket = await cancelStartTicket(state.ticketPath);
};

const applyLaunchOutcome = async (
  request: OpenRequest,
  claimToken: string,
  launchHc: HcRuntime,
  started: PiLaunchResult,
  state: LaunchState,
): Promise<void> => {
  const outcome = launchOutcomeDecision(launchFacts(started));

  if (outcome === 'notCreated') {
    await abandonTicket(state);

    if (state.ticket === 'taken') {
      await recoverTakenTicket(request, claimToken, launchHc, started, state);

      if (request.hc.signal?.aborted === true) {
        request.hc.signal.throwIfAborted();
      }

      return;
    }

    throw launchFailure(started);
  }

  state.terminal = started.terminal;
  state.terminalState = 'live';

  await waitForTakeover(request.root, claimToken, request.hc.signal);
  state.adopted = true;
  state.ticket = 'taken';

  if (request.hc.signal?.aborted === true) {
    request.hc.signal.throwIfAborted();
  }
};

const runningTerminal = async (
  request: OpenRequest,
  record: SavedArchitectRecord | undefined,
): Promise<string | undefined> => {
  const lockPath = architectLockPath(request.root);
  const holder = await readLiveLockHolder(lockPath);

  if (holder === undefined) {
    return undefined;
  }

  const selection = openTerminal({
    root: request.root,
    holder,
    record,
  });

  if (selection.kind === 'refuse') {
    throw refusal(selection.checkout);
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

const terminalStateOf = async (
  launchHc: HcRuntime,
  token: string,
): Promise<StartTicketTerminal> => {
  const lookup = await lookupLaunchTerminal({ kind: 'open', identifier: token, hc: launchHc });

  if (lookup.kind === 'found') {
    return lookup.state === 'live' ? 'live' : 'ended';
  }

  return lookup.kind === 'absent' ? 'none' : 'unread';
};

const sweepOwnStart = async (
  root: string,
  claimToken: string,
  launchHc: HcRuntime,
): Promise<boolean> => {
  const sweep = await sweepStartFolder({
    root,
    currentToken: claimToken,
    terminalOf: (token) => terminalStateOf(launchHc, token),
  });

  return sweep === 'starting';
};

const finishLaunch = async (
  request: OpenRequest,
  claim: { release: () => Promise<void>; token: string },
  state: LaunchState,
  launchHc: HcRuntime,
): Promise<boolean> => {
  const kept = await releaseClaim({ claim, ...state, hc: launchHc });

  if (!kept && state.ticket === 'taken') {
    await deleteStartMarker(request.root, claim.token).catch(() => undefined);
  }

  return kept;
};

const recoverAbandonedTerminal = async (
  claimToken: string,
  launchHc: HcRuntime,
  state: LaunchState,
): Promise<void> => {
  if (state.ticket !== 'taken' || state.terminal !== undefined) {
    return;
  }

  if (state.terminalState !== 'unknown') {
    return;
  }

  const lookup = await launchLookup({ kind: 'open', identifier: claimToken, hc: launchHc });

  if (lookup.kind === 'found') {
    state.terminal = lookup.terminal;
    state.terminalState = 'live';

    return;
  }

  state.terminalState = lookup.kind === 'absent' ? 'absent' : 'unknown';
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

  const claim = await claimArchitectLock(request.root, claimOptions);

  if (claim.kind === 'refused') {
    throw startingError(request.root);
  }

  const launchHc = { ...request.hc, signal: undefined };

  const state: LaunchState = {
    ticket: 'notCreated',
    ticketPath: undefined,
    terminal: undefined,
    terminalState: 'unknown',
    adopted: false,
  };

  try {
    const starting = await sweepOwnStart(request.root, claim.token, launchHc);

    if (starting) {
      throw startingError(request.root);
    }

    state.ticketPath = await createStartTicket(request.root, claim.token);

    const prepared = await prepareArchitectStart(
      request,
      record?.sessionFile ?? undefined,
      claim.token,
    );

    request.hc.signal?.throwIfAborted();

    const started = await launchArchitect(launchHc, request, prepared, state.ticketPath);

    await applyLaunchOutcome(request, claim.token, launchHc, started, state);

    const result = launchResult(prepared);

    await finishLaunch(request, claim, state, launchHc);

    return result;
  } catch (error) {
    await abandonTicket(state);
    await recoverAbandonedTerminal(claim.token, launchHc, state);

    const kept = await finishLaunch(request, claim, state, launchHc);

    if (kept) {
      throw openKeptClaimError(request.root);
    }

    throw error;
  }
};
