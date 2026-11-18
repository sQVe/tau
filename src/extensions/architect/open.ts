import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { userConfigPath } from '../../config/config.js';
import { readRoleModel } from '../../config/roleModels.js';
import { isMissingFile } from '../../errors.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import { get } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { findPane } from '../../piStart/herdrPane.js';
import { startPiSession } from '../../piStart/piStart.js';
import type { PiStartTarget } from '../../piStart/piStart.js';
import { architectLockPath } from './lock.js';
import { openPlacement } from './openPlacementDecision.js';
import type { OpenPlacement } from './openPlacementDecision.js';
import { readArchitectRecord, readAskRecords } from './record.js';

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

const liveTerminal = async (
  hc: HcRuntime,
  terminal: string | null | undefined,
): Promise<string | undefined> => {
  if (terminal === null || terminal === undefined) {
    return undefined;
  }

  const found = await get(hc, terminal).catch(() => undefined);

  return found?.state === 'live' ? terminal : undefined;
};

const terminalRunsAsk = async (root: string, terminal: string | undefined): Promise<boolean> => {
  if (terminal === undefined) {
    return false;
  }

  const asks = await readAskRecords(root);

  return asks.some((ask) => ask.status === 'running' && ask.terminal === terminal);
};

const readLeadSpace = async (request: OpenRequest): Promise<string | undefined> => {
  const lead = await get(request.hc, request.leadTerminal);

  return lead.labels?.['herdr.space'];
};

const placementOf = async (
  request: OpenRequest,
  recordedTerminal: string | null | undefined,
): Promise<OpenPlacement> => {
  const holder = await readLiveLockHolder(architectLockPath(request.root));

  if (holder === undefined) {
    const leadSpace = await readLeadSpace(request);

    return openPlacement({ holder, liveTerminal: undefined, terminalRunsAsk: false, leadSpace });
  }

  const terminal = await liveTerminal(request.hc, recordedTerminal);

  return openPlacement({
    holder,
    liveTerminal: terminal,
    terminalRunsAsk: await terminalRunsAsk(request.root, terminal),
    leadSpace: undefined,
  });
};

const paneTarget = async (request: OpenRequest): Promise<PiStartTarget> => {
  const pane = await findPane(request.hc, request.leadTerminal);

  if (pane === undefined) {
    throw new Error(`herdr-app shows no pane for the lead terminal ${request.leadTerminal}.`);
  }

  return { pane };
};

// Opens the checkout's architect beside the lead, or resumes its recorded session. A live lock
// holder means an architect runs. Its live recorded terminal is reported, not started again, unless
// an ask runs there. Any other live holder refuses instead of starting a second architect.
export const openArchitect = async (request: OpenRequest): Promise<OpenResult> => {
  const record = await readArchitectRecord(request.root);
  const placement = await placementOf(request, record?.terminal);

  if (placement.kind === 'refuse') {
    throw new Error(`The architect is already running in ${placement.checkout}.`);
  }

  if (placement.kind === 'reuse') {
    return { status: 'running', terminal: placement.terminal };
  }

  const model = requireModel(request);
  const recordedSession = record?.sessionFile ?? undefined;
  const resume = recordedSession !== undefined && (await fileExists(recordedSession));
  const session = resume ? recordedSession : undefined;

  const target: PiStartTarget =
    placement.kind === 'pane'
      ? await paneTarget(request)
      : { name: `architect-${basename(request.root)}` };

  const task =
    session === undefined
      ? await freshTask(request.root, request.leadTerminal, request.request)
      : resumeTask(request.root, request.leadTerminal, request.request);

  await startPiSession(request.hc, {
    folder: request.root,
    target,
    task,
    model,
    session,
    environment: { TAU_ROLE: 'architect', TAU_LEAD_TERMINAL: request.leadTerminal },
  });

  return session === undefined
    ? { status: 'opened', sessionFile: null }
    : { status: 'resumed', sessionFile: session };
};
