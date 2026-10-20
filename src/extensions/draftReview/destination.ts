import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { isMissingFile } from '../../errors.js';
import { decideDestination } from './reviewDecisions.js';
import type { DestinationDecision } from './reviewDecisions.js';

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

const escapes = (tauDirectory: string, target: string) => {
  const inside = relative(tauDirectory, target);

  return inside === '..' || inside.startsWith('../') || isAbsolute(inside);
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
    insideTauDirectory: !escapes(tauDirectory, real),
  });

  if (decision !== 'writable') {
    return refuse(target, decision);
  }

  return { dev: stats.dev, ino: stats.ino };
};

// Opens without following a final symlink, then requires the opened file to be the one checked
// before the open. A directory swapped for a symlink in between opens a different file and is
// refused before anything is truncated. Returns false, and writes nothing, when the file is gone.
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
    const sameFile = stats.dev === checked.dev && stats.ino === checked.ino;

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
