import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ConfigLocation, ConfigWarnings } from '../../../config/config.js';
import { userConfigPath } from '../../../config/config.js';
import { readRoleModel } from '../../../config/roleModels.js';
import { errorMessage, isMissingFile } from '../../../errors.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import type { LiveLockHolder } from '../../../fileLock/fileLock.js';
import { isBareRoot } from '../../../git.js';
import { get } from '../../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../../hc/hc.js';
import { findPane } from '../../../piStart/herdrPane.js';
import { startPiSession, startPiSessionLeftOf } from '../../../piStart/piStart.js';
import { architectLockPath } from '../lock.js';
import { readArchitectRecord, readAskRecords } from '../record.js';
import type { SavedArchitectRecord } from '../record.js';
import { eligibleTerminal, openCandidate, openReuse } from './openReuseDecision.js';
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
  | { status: 'opened'; sessionFile: null }
  | { status: 'running'; terminal: string }
  | { status: 'resumed'; sessionFile: string };

const askLabel = 'tau.architect.ask';

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

  return `You are the architect for ${root}. ${context} The lead terminal is ${leadTerminal}. Talk to the user about design, write the tickets the slice needs, then send the lead the step 11 values with handover send to ${leadTerminal} with final set to true, and end your turn.\n\nThe user's request:\n${userRequest}`;
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
  recordedTerminal: string | null | undefined,
  holder: LiveLockHolder,
): Promise<OpenCandidate> => {
  const found = await readLiveTerminal(request.hc, recordedTerminal);
  const liveTerminal = found === undefined ? undefined : (recordedTerminal ?? undefined);

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

const startArchitect = async (
  request: OpenRequest,
  recordedSession: string | undefined,
): Promise<string | undefined> => {
  const leadSpace = await readLeadSpace(request);
  const model = requireModel(request);
  const resume = recordedSession !== undefined && (await fileExists(recordedSession));
  const session = resume ? recordedSession : undefined;
  const pane = hasSpace(leadSpace) ? await findLeadPane(request) : undefined;

  const task =
    session === undefined
      ? await freshTask(request.root, request.leadTerminal, request.request)
      : resumeTask(request.root, request.leadTerminal, request.request);

  const start = {
    folder: request.root,
    task,
    model,
    session,
    bareRoot: await isBareRoot(request.root),
    environment: { TAU_ROLE: 'architect', TAU_LEAD_TERMINAL: request.leadTerminal },
  };

  if (pane === undefined) {
    const target = { name: `architect-${basename(request.root)}` };

    await startPiSession(request.hc, { ...start, target });
  } else {
    await startPiSessionLeftOf(request.hc, { ...start, pane });
  }

  return session;
};

const refusal = (checkout: string): Error =>
  new Error(`The architect is already running in ${checkout}.`);

const runningTerminal = async (
  request: OpenRequest,
  recordedTerminal: string | null | undefined,
): Promise<string | undefined> => {
  const lockPath = architectLockPath(request.root);
  const holder = await readLiveLockHolder(lockPath);

  if (holder === undefined) {
    return undefined;
  }

  const candidate = await candidateOf(request, recordedTerminal, holder);

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

const recordedTerminal = (record: SavedArchitectRecord | undefined): string | null | undefined =>
  record?.version === 2 ? record.owner?.terminal : record?.terminal;

export const openArchitect = async (request: OpenRequest): Promise<OpenResult> => {
  const record = await readArchitectRecord(request.root);
  const running = await runningTerminal(request, recordedTerminal(record));

  if (running !== undefined) {
    return { status: 'running', terminal: running };
  }

  const session = await startArchitect(request, record?.sessionFile ?? undefined);

  return session === undefined
    ? { status: 'opened', sessionFile: null }
    : { status: 'resumed', sessionFile: session };
};
