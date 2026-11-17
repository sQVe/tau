import { readdir, stat } from 'node:fs/promises';
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

const designFiles = async (root: string): Promise<string[]> => {
  const directory = join(root, '.tau', 'slices');

  const names = await readdir(directory).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  });

  const paths = names.map((name) => join(directory, name, 'design.md'));
  const existing = await Promise.all(paths.map((path) => fileExists(path)));

  return paths.filter((_, index) => existing[index] === true);
};

const freshTask = async (root: string): Promise<string> => {
  const designs = await designFiles(root);

  const context =
    designs.length === 0
      ? 'Read AGENTS.md before you design anything.'
      : `Read the slice design: ${designs.join(', ')}.`;

  return `You are the architect for ${root}. ${context} Talk to the user about design, write the tickets the slice needs, then send the lead the step 11 values with handover send and end your turn.`;
};

const resumeTask = (root: string): string =>
  `Resume the architect session for ${root}. The lead opened it for a design conversation with the user.`;

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
  const task = session === undefined ? await freshTask(request.root) : resumeTask(request.root);

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
