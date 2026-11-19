import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, isMissingFile } from '../../errors.js';

const scratchRootName = 'tau-worker-scratch';

export const scratchRootFor = (agentDirectory: string): string =>
  join(agentDirectory, 'tmp', scratchRootName);

export const scratchDirectoryFor = (agentDirectory: string, assignmentId: string): string =>
  join(scratchRootFor(agentDirectory), assignmentId);

const refuseRedirected = async (folder: string, rootName: string): Promise<void> => {
  let canonical: string;

  try {
    canonical = await realpath(folder);
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }

    throw error;
  }

  if (canonical !== folder) {
    throw new Error(`Temporary root ${rootName} is redirected. Creation refused.`);
  }
};

// A redirected root would put the folder where cleanup refuses to remove it.
export const createScratchDirectory = async (
  agentDirectory: string,
  assignmentId: string,
): Promise<void> => {
  const canonicalAgent = await realpath(agentDirectory);
  const temporaryFolder = join(canonicalAgent, 'tmp');

  await refuseRedirected(temporaryFolder, 'tmp');
  await refuseRedirected(join(temporaryFolder, scratchRootName), scratchRootName);

  await mkdir(join(temporaryFolder, scratchRootName, assignmentId), {
    recursive: true,
    mode: 0o700,
  });
};

const isDotName = (name: string): boolean => name === '' || name === '.' || name === '..';

const hasSeparator = (name: string): boolean => name.includes('/') || name.includes('\\');

const isPathName = (name: string): boolean => !isDotName(name) && !hasSeparator(name);

// Throws when the root is redirected or the name is a path. Returns the folder inside the canonical
// root. `action` names the refused work in the message.
export const guardedTemporaryFolder = async (
  agentDirectory: string,
  rootName: string,
  name: string,
  action: string,
): Promise<string> => {
  if (!isPathName(name)) {
    throw new Error(`Invalid temporary folder name ${JSON.stringify(name)}. ${action} refused.`);
  }

  const canonicalAgent = await realpath(agentDirectory);
  const expectedRoot = join(canonicalAgent, 'tmp', rootName);
  const canonicalRoot = await realpath(expectedRoot);

  if (canonicalRoot !== expectedRoot) {
    throw new Error(`Temporary root ${rootName} is redirected. ${action} refused.`);
  }

  return join(canonicalRoot, name);
};

// Returns the cleanup error, so a caller without a handle can still report it. A missing folder is
// success.
export const removeAgentTemporaryFolder = async (
  agentDirectory: string,
  rootName: string,
  name: string,
): Promise<string | undefined> => {
  try {
    const folder = await guardedTemporaryFolder(agentDirectory, rootName, name, 'Cleanup');

    await rm(folder, { recursive: true, force: true });

    return undefined;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    return errorMessage(error);
  }
};

export const removeScratchDirectory = (
  agentDirectory: string,
  assignmentId: string,
): Promise<string | undefined> =>
  removeAgentTemporaryFolder(agentDirectory, scratchRootName, assignmentId);

export const errorAfterScratchCleanup = async (
  agentDirectory: string,
  assignmentId: string,
  error: unknown,
): Promise<unknown> => {
  const cleanupError = await removeScratchDirectory(agentDirectory, assignmentId);

  if (cleanupError === undefined) {
    return error;
  }

  return new Error(
    `${errorMessage(error)} Also failed to remove the worker scratch folder: ${cleanupError}`,
    { cause: error },
  );
};
