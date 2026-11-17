import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { CommandRuntime } from '../../command.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { userConfigPath } from '../../config/config.js';
import { readRoleModel } from '../../config/roleModels.js';
import { isMissingFile } from '../../errors.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import { startPiSession } from '../../piStart/piStart.js';
import { architectLockPath } from './lock.js';
import { readArchitectRecord } from './record.js';

export interface OpenRequest {
  root: string;
  leadTerminal: string;
  location: ConfigLocation;
  ui: ConfigWarnings;
  runtime: CommandRuntime;
}

export type OpenResult =
  | { status: 'opened'; sessionFile: null }
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

const freshTask = async (root: string, leadTerminal: string): Promise<string> => {
  const design = await ownSliceDesign(root);

  const context =
    design === undefined
      ? 'Read AGENTS.md before you design anything.'
      : `Read the slice design: ${design}.`;

  return `You are the architect for ${root}. ${context} The lead terminal is ${leadTerminal}. Talk to the user about design, write the tickets the slice needs, then send the lead the step 11 values with handover send to ${leadTerminal} with final set to true, and end your turn.`;
};

const resumeTask = (root: string, leadTerminal: string): string =>
  `Resume the architect session for ${root}. The lead terminal is ${leadTerminal}. The lead opened it for a design conversation with the user.`;

const requireModel = (request: OpenRequest): string => {
  const model = readRoleModel(request.location, 'architect', request.ui);

  if (model === undefined) {
    throw new Error(
      `Set roles.architect.model in ${userConfigPath(request.location.agentDirectory)}.`,
    );
  }

  return model;
};

// Opens the checkout's architect tab, or resumes its recorded session. A live lock holder means
// another architect already runs, so this refuses instead of starting a second one.
export const openArchitect = async (request: OpenRequest): Promise<OpenResult> => {
  const holder = await readLiveLockHolder(architectLockPath(request.root));

  if (holder !== undefined) {
    throw new Error(`The architect is already running in ${holder.checkout}.`);
  }

  const model = requireModel(request);
  const record = await readArchitectRecord(request.root);
  const recordedSession = record?.sessionFile ?? undefined;
  const resume = recordedSession !== undefined && (await fileExists(recordedSession));
  const session = resume ? recordedSession : undefined;

  const task =
    session === undefined
      ? await freshTask(request.root, request.leadTerminal)
      : resumeTask(request.root, request.leadTerminal);

  await startPiSession(request.runtime, {
    folder: request.root,
    target: { name: `architect-${basename(request.root)}` },
    task,
    model,
    session,
    environment: { TAU_ROLE: 'architect', TAU_LEAD_TERMINAL: request.leadTerminal },
  });

  return session === undefined
    ? { status: 'opened', sessionFile: null }
    : { status: 'resumed', sessionFile: session };
};
