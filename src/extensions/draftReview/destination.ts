import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { isMissingFile } from '../../errors.js';
import { climbsOut } from '../../tauDirectory.js';
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

const readChunkBytes = 65536;

// Reads at most one byte past expectedByteLength. A longer file then cannot match, and a file that
// keeps growing cannot keep the read going.
const readHeldContent = async (handle: FileHandle, expectedByteLength: number): Promise<string> => {
  const chunks: Buffer[] = [];
  const readLimit = expectedByteLength + 1;
  let position = 0;

  while (position < readLimit) {
    const chunkBytes = Math.min(readChunkBytes, readLimit - position);
    const buffer = Buffer.alloc(chunkBytes);
    // oxlint-disable-next-line no-await-in-loop -- Each read starts where the previous one ended.
    const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);

    if (bytesRead === 0) {
      break;
    }

    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }

  return Buffer.concat(chunks).toString('utf8');
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
// when a parent directory moves. Then reads the opened file and requires it to hold expectedContent,
// the content the caller decided on, because a file can be replaced by rename after the caller read
// it. All of this happens before anything is truncated. Returns false, and writes nothing, when the
// file is gone or no longer holds expectedContent.
export const writeDestination = async (
  tauDirectory: string,
  path: string,
  content: string,
  expectedContent: string,
): Promise<boolean> => {
  const target = join(tauDirectory, path);
  const checked = await requireWritableDestination(tauDirectory, path);

  if (checked === undefined) {
    return false;
  }

  const handle = await open(target, constants.O_RDWR | constants.O_NOFOLLOW).catch(
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

    const currentContent = await readHeldContent(handle, Buffer.byteLength(expectedContent));

    if (currentContent !== expectedContent) {
      return false;
    }

    await handle.truncate(0);
    await handle.writeFile(content);

    return true;
  } finally {
    await handle.close();
  }
};
