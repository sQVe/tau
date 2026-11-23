import { randomUUID } from 'node:crypto';

import type { ConfigLocation, ConfigWarnings } from '../../../config/config.js';
import { notifyOnce, userConfigPath } from '../../../config/config.js';
import { readRoleModel } from '../../../config/roleModels.js';
import { errorMessage } from '../../../errors.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { get, run, wait } from '../../../hc/hc.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { piArguments } from '../../../piStart/piArguments.js';
import { launchTimeoutMilliseconds } from '../../../piStart/piStart.js';
import { releaseClaim } from '../claimRelease/claimRelease.js';
import type { ClaimReleaseFacts } from '../claimRelease/claimReleaseDecision.js';
import { launchLookup, lookupLaunchTerminal } from '../claimRelease/launchLookup.js';
import { launchOutcomeDecision } from '../claimRelease/launchOutcomeDecision.js';
import type { LaunchOutcome } from '../claimRelease/launchOutcomeDecision.js';
import type { LiveAskResult, StartLiveAsk } from '../liveAsk.js';
import { architectLockPath, claimArchitectLock } from '../lock.js';
import type { ArchitectClaimOptions } from '../lock.js';
import {
  askRecordPath,
  changeAskRecord,
  readArchitectRecord,
  readAskRecord,
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
  sweepStartFolder,
  wrapStartArgv,
} from '../startTicket/startTicket.js';
import type { StartTicketTerminal } from '../startTicket/startTicketDecision.js';
import { askOutcome, askRoute, askTransition, staleAskRepair } from './askDecision.js';
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
  terminalState: ClaimReleaseFacts['terminal'];
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

const askUnconfirmedLaunchDetail = 'The ask terminal launch could not be confirmed.';

export const askWaitFailureDetail = (cancelled: boolean, error: unknown): string =>
  `The ask wait was ${cancelled ? 'cancelled' : 'failed'}: ${errorMessage(error)}`;

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

  if (staleAskRepair({ status: newest.status, terminalState }) === 'repair') {
    await changeHiddenAsk(root, newest.askId, (current) =>
      current.status === 'running' && current.terminal === newest.terminal
        ? {
            ...current,
            status: 'failed',
            detail: 'The ask terminal ended without settling the ask.',
          }
        : undefined,
    );

    return undefined;
  }

  return terminalState === 'live' ? newest : undefined;
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
      timedOut: false,
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

const settleWaitFailure = async (
  request: AskRequest,
  started: HiddenAskRecord,
  state: HiddenAskClaim,
  settle: SettleHiddenAskClaim,
  error: unknown,
): Promise<never> => {
  const cancelled = request.hc.signal?.aborted === true;

  state.terminalState = 'live';

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
  state.terminalState = 'live';

  const kept = await settle();
  const status = kept ? 'running' : 'timeout';

  const detail = kept
    ? askUnconfirmedStopDetail
    : 'The ask reached its deadline before the architect answered.';

  const reason = kept
    ? askKeptClaimMessage(request.root)
    : 'The ask reached its deadline. Call architect open to talk to the architect.';

  const changed = await changeHiddenAsk(request.root, started.askId, (current) => ({
    ...current,
    status,
    detail,
  }));

  const current = changed?.record;

  if (current?.route === 'hidden' && current.status === 'sent' && current.answer !== null) {
    return { status: 'ended', askId: started.askId, answer: current.answer };
  }

  return needsOpen(reason);
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
    state.terminalState = 'live';

    const started: HiddenAskRecord = { ...initial, terminal: launched.terminal };

    await changeHiddenAsk(request.root, initial.askId, (current) => ({
      ...current,
      terminal: launched.terminal ?? null,
    }));

    return { started, terminal: launched.terminal };
  }

  await abandonAskTicket(state, ticketPath);

  if (state.ticket === 'taken') {
    const lookup = await launchLookup({
      kind: 'ask',
      identifier: initial.askId,
      hc: request.hc,
    });

    if (lookup.kind === 'found') {
      state.terminal = lookup.terminal;
      state.terminalState = 'live';

      const started: HiddenAskRecord = { ...initial, terminal: lookup.terminal };

      await changeHiddenAsk(request.root, initial.askId, (current) => ({
        ...current,
        terminal: lookup.terminal,
      }));

      return { started, terminal: lookup.terminal };
    }

    if (lookup.kind === 'unread') {
      state.ticket = 'unread';

      await changeHiddenAsk(request.root, initial.askId, (current) => ({
        ...current,
        status: 'running',
        detail: askUnconfirmedLaunchDetail,
      }));

      throw launched.error;
    }

    state.terminalState = 'absent';
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

  state.terminalState = 'ended';

  const recorded = await readAskRecord(request.root, askId);
  const latest: HiddenAskRecord = recorded?.route === 'hidden' ? recorded : started;

  const outcome = askOutcome({
    status: latest.status,
    ended: waited.ended,
    exitCode: waited.exit_code ?? null,
  });

  if (outcome === 'answered' && latest.answer !== null) {
    return { status: 'ended', askId, answer: latest.answer };
  }

  if (outcome === 'needsOpen') {
    await changeHiddenAsk(request.root, askId, (current) => ({
      ...current,
      status: 'failed',
      detail: 'The ask ended without sending an answer.',
    }));

    return needsOpen(
      'The architect ended without sending an answer. Call architect open to talk to it.',
    );
  }

  await changeHiddenAsk(request.root, askId, (current) => ({
    ...current,
    status: 'failed',
    detail: 'The ask terminal failed before the architect answered.',
  }));

  return {
    status: 'failed',
    askId,
    reason: 'The ask terminal failed before the architect answered. Call architect open instead.',
  };
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

  const launchHc = { ...request.hc, signal: undefined };

  const state: HiddenAskClaim = {
    ticket: 'notCreated',
    terminal: undefined,
    terminalState: 'unknown',
    settled: false,
    kept: false,
  };

  let ticketPath: string | undefined;

  const settle = async (): Promise<boolean> => {
    if (state.settled) {
      return state.kept;
    }

    state.settled = true;

    if (state.ticket === 'notCreated' && ticketPath !== undefined) {
      state.ticket = await cancelStartTicket(ticketPath);
    }

    state.kept = await releaseClaim({
      claim,
      ticket: state.ticket,
      adopted: false,
      terminal: state.terminal,
      terminalState: state.terminalState,
      hc: request.hc,
    });

    if (!state.kept && state.ticket === 'taken') {
      await deleteStartMarker(request.root, claim.token).catch(() => undefined);
    }

    return state.kept;
  };

  const terminalOf = async (token: string): Promise<StartTicketTerminal> => {
    const lookup = await lookupLaunchTerminal({ kind: 'open', identifier: token, hc: launchHc });

    if (lookup.kind === 'found') {
      return lookup.state === 'live' ? 'live' : 'ended';
    }

    return lookup.kind === 'absent' ? 'none' : 'unread';
  };

  try {
    const sweep = await sweepStartFolder({
      root: request.root,
      currentToken: claim.token,
      terminalOf,
    });

    if (sweep === 'starting') {
      state.settled = true;
      await claim.release();

      return needsOpen(askStartingReason);
    }

    ticketPath = await createStartTicket(request.root, claim.token);

    return await runHiddenAsk(request, sessionFile, model, claim.token, ticketPath, state, settle);
  } finally {
    await settle();
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
