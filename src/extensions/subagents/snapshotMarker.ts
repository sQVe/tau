import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, isMissingFile } from '../../errors.js';
import { snapshotRootName } from './packageSnapshot.js';
import { guardedTemporaryFolder } from './workerScratch.js';

const unusedMarkerName = '.tau-unused-since';

const markerMode = 0o600;

const markerPathFor = async (agentDirectory: string, name: string): Promise<string> => {
  const folder = await guardedTemporaryFolder(
    agentDirectory,
    snapshotRootName,
    name,
    'Marker change',
  );

  return join(folder, unusedMarkerName);
};

// The marker's own time, never its target's: a link at the marker path is not followed.
export const readUnusedSince = async (snapshot: string): Promise<number | undefined> => {
  try {
    const stats = await lstat(join(snapshot, unusedMarkerName));

    return stats.mtimeMs;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

// O_NOFOLLOW makes the open fail on a link, and the time is set through the handle.
export const markSnapshotUnused = async (
  agentDirectory: string,
  name: string,
  now: number,
): Promise<string | undefined> => {
  try {
    const marker = await markerPathFor(agentDirectory, name);

    const handle = await open(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      markerMode,
    );

    try {
      const markedAt = new Date(now);

      await handle.utimes(markedAt, markedAt);
    } finally {
      await handle.close();
    }

    return undefined;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    return `Marking snapshot ${name} unused failed: ${errorMessage(error)}.`;
  }
};

export const clearSnapshotMarker = async (
  agentDirectory: string,
  name: string,
): Promise<string | undefined> => {
  try {
    await rm(await markerPathFor(agentDirectory, name), { force: true });

    return undefined;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    return `Clearing the unused marker of snapshot ${name} failed: ${errorMessage(error)}.`;
  }
};
