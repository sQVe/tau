import type { ConfigLocation, ConfigWarnings } from '../../../config/config.js';
import { notifyOnce, userConfigPath } from '../../../config/config.js';
import { readRoleModel } from '../../../config/roleModels.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { get } from '../../../hc/hc.js';
import type { HcRuntime } from '../../../hc/hc.js';
import type { LiveAskResult, StartLiveAsk } from '../liveAsk.js';
import { architectLockPath } from '../lock.js';
import type { ArchitectClaimOptions } from '../lock.js';
import { readArchitectRecord, readAskRecords, updateHiddenAskRecord } from '../record.js';
import type { AskRecordGap, HiddenAskRecord, SavedArchitectRecord } from '../record.js';
import { acquireStartFence } from '../startFence/startFence.js';
import type { StartFenceBlocker } from '../startFence/startFence.js';
import {
  malformedStartMarkerReason,
  startHeldByProcessReason,
} from '../startTicket/startTicket.js';
import { askRoute, staleAskRepair } from './askDecision.js';
import type { ArchitectPublication } from './askDecision.js';
import { startHiddenAskRun } from './askHiddenRun.js';

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

export const askStartingReason = 'The architect is starting. Ask again shortly.';

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

  if (terminalState === 'live') {
    return newest;
  }

  await updateHiddenAskRecord(root, newest.askId, (current) =>
    staleAskRepair({
      status: current.status,
      terminalState,
      recordTerminal: current.terminal,
      endedTerminal: terminal.address,
    }) === 'repair'
      ? {
          ...current,
          status: 'failed',
          detail: 'The ask terminal ended without settling the ask.',
        }
      : undefined,
  );

  return undefined;
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

const blockedStartReason = (blocker: StartFenceBlocker): string => {
  if (blocker.kind === 'runningProcess') {
    return startHeldByProcessReason(blocker.processId);
  }

  return blocker.kind === 'malformedMarker'
    ? malformedStartMarkerReason(blocker.path)
    : askStartingReason;
};

const askHiddenArchitect = async (
  request: AskRequest,
  sessionFile: string,
  claimOptions: ArchitectClaimOptions,
): Promise<AskResult> => {
  const model = requireModel(request);
  const acquisition = await acquireStartFence(request.root, claimOptions);

  if (acquisition.kind === 'refused') {
    return needsOpen(askStartingReason);
  }

  if (acquisition.kind === 'blocked') {
    return needsOpen(blockedStartReason(acquisition.blocker));
  }

  const fence = acquisition.fence;
  const run = startHiddenAskRun(request, fence);

  try {
    await fence.createTicket();

    await claimOptions.beforeDispatch?.();

    return await run.start(sessionFile, model);
  } finally {
    await run.settle();
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
