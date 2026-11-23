import { randomUUID } from 'node:crypto';

import type { ConfigLocation, ConfigWarnings } from '../../../config/config.js';
import { notifyOnce, userConfigPath } from '../../../config/config.js';
import { readRoleModel } from '../../../config/roleModels.js';
import { errorMessage } from '../../../errors.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { HcError, get, run, wait } from '../../../hc/hc.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { piArguments } from '../../../piStart/piArguments.js';
import { launchTimeoutMilliseconds, missingExecutable } from '../../../piStart/piStart.js';
import { releaseClaim } from '../claimRelease/claimRelease.js';
import { launchLookup } from '../claimRelease/launchLookup.js';
import { launchOutcomeDecision } from '../claimRelease/launchOutcomeDecision.js';
import type { LiveAskResult, StartLiveAsk } from '../liveAsk.js';
import { architectLockPath, claimArchitectLock } from '../lock.js';
import type { ArchitectClaimOptions } from '../lock.js';
import {
  askRecordPath,
  readArchitectRecord,
  readAskRecord,
  readAskRecords,
  writeAskRecord,
} from '../record.js';
import type { AskRecordGap, HiddenAskRecord, SavedArchitectRecord } from '../record.js';
import { askOutcome, askRoute, staleAskRepair } from './askDecision.js';
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
  launch: 'notRun' | 'refused' | 'started';
  terminal: string | undefined;
  terminalState: 'unknown' | 'live' | 'ended' | 'absent';
  settled: boolean;
  kept: boolean;
}

interface HiddenAskLaunch {
  outcome: 'created' | 'refused' | 'unknown';
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

export const askWaitFailureDetail = (cancelled: boolean, error: unknown): string =>
  `The ask wait was ${cancelled ? 'cancelled' : 'failed'}: ${errorMessage(error)}`;

const millisecondsPerSecond = 1000;

const reportAskGaps = (ui: ConfigWarnings, gaps: AskRecordGap[]): void => {
  for (const gap of gaps) {
    notifyOnce(ui, gap.path, 'ask-record', gap.reason, 'warning');
  }
};

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
    await writeAskRecord(root, {
      ...newest,
      status: 'failed',
      detail: 'The ask terminal ended without settling the ask.',
    });

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
): Promise<HiddenAskLaunch> => {
  const hc = { ...request.hc, signal: undefined };

  try {
    const terminal = await run(hc, {
      argv: piArguments({
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
      cwd: request.root,
      background: true,
      noParent: true,
      notify: false,
      labels: { 'tau.architect.ask': initial.askId },
      timeout: launchTimeoutMilliseconds,
    });

    const replyTerminal = terminal.address === '' ? 'malformed' : 'valid';

    const outcome = launchOutcomeDecision({
      ran: true,
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
    const hcError = error instanceof HcError ? error : undefined;
    const spawnFailed = hcError?.kind === 'spawn_failed';
    const executableMissing = hcError !== undefined && missingExecutable(hcError.message);
    const refused = spawnFailed || executableMissing;

    return {
      outcome: refused ? 'refused' : 'unknown',
      terminal: undefined,
      error,
    };
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
    await writeAskRecord(request.root, {
      ...started,
      status: 'running',
      detail: askUnconfirmedStopDetail,
    });

    throw new Error(askKeptClaimMessage(request.root));
  }

  await writeAskRecord(request.root, {
    ...started,
    status: 'failed',
    detail: askWaitFailureDetail(cancelled, error),
  });

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

  await writeAskRecord(request.root, { ...started, status, detail });

  return needsOpen(reason);
};

const resolveUnknownHiddenLaunch = async (
  request: AskRequest,
  initial: HiddenAskRecord,
  launched: HiddenAskLaunch,
  state: HiddenAskClaim,
): Promise<string> => {
  state.launch = 'started';

  const lookup = await launchLookup({ kind: 'ask', identifier: initial.askId, hc: request.hc });

  if (lookup.kind === 'found') {
    return lookup.terminal;
  }

  const absent = lookup.kind === 'absent';
  const status = absent ? 'failed' : 'running';

  const detail = absent
    ? 'The ask terminal could not be started.'
    : 'The ask terminal launch could not be confirmed.';

  state.terminalState = absent ? 'absent' : 'unknown';

  await writeAskRecord(request.root, { ...initial, status, detail });

  throw launched.error;
};

const launchHiddenRecord = async (
  request: AskRequest,
  initial: HiddenAskRecord,
  recordPath: string,
  model: string,
  claimToken: string,
  state: HiddenAskClaim,
): Promise<{ started: HiddenAskRecord; terminal: string }> => {
  const launched = await hiddenAskLaunch(request, initial, recordPath, model, claimToken);

  if (launched.outcome === 'refused') {
    state.launch = 'refused';

    await writeAskRecord(request.root, {
      ...initial,
      status: 'failed',
      detail: 'The ask terminal could not be started.',
    });

    throw launched.error;
  }

  const terminal =
    launched.outcome === 'unknown'
      ? await resolveUnknownHiddenLaunch(request, initial, launched, state)
      : launched.terminal;

  if (terminal === undefined) {
    state.launch = 'started';

    throw launched.error;
  }

  state.launch = 'started';
  state.terminal = terminal;
  state.terminalState = 'live';

  const started: HiddenAskRecord = { ...initial, terminal };

  await writeAskRecord(request.root, started);

  return { started, terminal };
};

const runHiddenAsk = async (
  request: AskRequest,
  sessionFile: string,
  model: string,
  claimToken: string,
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
    await writeAskRecord(request.root, {
      ...initial,
      status: 'failed',
      detail: 'The ask was cancelled before its terminal started.',
    });

    request.hc.signal.throwIfAborted();
  }

  const { started, terminal } = await launchHiddenRecord(
    request,
    initial,
    recordPath,
    model,
    claimToken,
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
    await writeAskRecord(request.root, {
      ...latest,
      status: 'failed',
      detail: 'The ask ended without sending an answer.',
    });

    return needsOpen(
      'The architect ended without sending an answer. Call architect open to talk to it.',
    );
  }

  await writeAskRecord(request.root, {
    ...latest,
    status: 'failed',
    detail: 'The ask terminal failed before the architect answered.',
  });

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

  const state: HiddenAskClaim = {
    launch: 'notRun',
    terminal: undefined,
    terminalState: 'unknown',
    settled: false,
    kept: false,
  };

  const settle = async (): Promise<boolean> => {
    if (state.settled) {
      return state.kept;
    }

    state.settled = true;

    state.kept = await releaseClaim({
      claim,
      launch: state.launch,
      adopted: false,
      terminal: state.terminal,
      terminalState: state.terminalState,
      hc: request.hc,
    });

    return state.kept;
  };

  try {
    return await runHiddenAsk(request, sessionFile, model, claim.token, state, settle);
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
