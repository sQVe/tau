import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { isMissingFile } from '../../errors.js';
import { decideDestination } from './reviewDecisions.js';
import type { DestinationDecision } from './reviewDecisions.js';
import { climbsOut } from './stage.js';

interface FileIdentity {
  dev: number;
  ino: number;
}

const refusals: Record<Exclude<DestinationDecision, 'writable'>, string> = {
  symlink: 'is now a symbolic link',
  'not-file': 'is no longer a regular file',
  'hard-linked': 'has another hard link',
  outside: 'resolves outside the .tau directory',
};

export class DestinationRefusalError extends Error {
  override name = 'DestinationRefusalError';
}

const refuse = (path: string, decision: Exclude<DestinationDecision, 'writable'>): never => {
  throw new DestinationRefusalError(`draft_review refused ${path}: it ${refusals[decision]}.`);
};

const kindOf = (stats: { isFile: () => boolean; isSymbolicLink: () => boolean }) => {
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }

  return stats.isFile() ? 'file' : 'other';
};

const lstatOptional = async (target: string) => {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

// Checks the file on disk now. A missing file passes with no identity, because nothing can be
// written to it. A symbolic link is refused before it is followed, so a dangling one is not missing.
export const requireWritableDestination = async (
  tauDirectory: string,
  path: string,
): Promise<FileIdentity | undefined> => {
  const target = join(tauDirectory, path);
  const stats = await lstatOptional(target);

  if (stats === undefined) {
    return undefined;
  }

  if (stats.isSymbolicLink()) {
    return refuse(target, 'symlink');
  }

  let real: string;

  try {
    real = await realpath(target);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }

  const decision = decideDestination({
    kind: kindOf(stats),
    linkCount: stats.nlink,
    insideTauDirectory: !climbsOut(relative(tauDirectory, real)),
  });

  if (decision !== 'writable') {
    return refuse(target, decision);
  }

  return { dev: stats.dev, ino: stats.ino };
};

// Checks before the open, so a special file such as a FIFO is never opened. After the open, checks
// the path again and requires it to name the opened file, because the same file can leave .tau
// when a parent directory moves. Both happen before anything is truncated. Returns false, and
// writes nothing, when the file is gone.
export const writeDestination = async (
  tauDirectory: string,
  path: string,
  content: string,
): Promise<boolean> => {
  const target = join(tauDirectory, path);
  const checked = await requireWritableDestination(tauDirectory, path);

  if (checked === undefined) {
    return false;
  }

  const handle = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      if (isMissingFile(error)) {
        return undefined;
      }

      throw error;
    },
  );

  if (handle === undefined) {
    return false;
  }

  try {
    const stats = await handle.stat();
    const located = await requireWritableDestination(tauDirectory, path);
    const sameFile = located?.dev === stats.dev && located.ino === stats.ino;

    const decision = decideDestination({
      kind: kindOf(stats),
      linkCount: stats.nlink,
      insideTauDirectory: sameFile,
    });

    if (decision !== 'writable') {
      refuse(target, decision);
    }

    await handle.truncate(0);
    await handle.writeFile(content);

    return true;
  } finally {
    await handle.close();
  }
};
