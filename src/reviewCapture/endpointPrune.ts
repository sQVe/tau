import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { isMissingFile } from '../errors.js';
import { readGit, runGit } from '../git.js';
import { decideEndpointPrune } from './endpointPruneDecision.js';
import type { DirectoryState } from './endpointPruneDecision.js';
import { refPrefix } from './endpointRetention.js';
import { generationFolderName, parseCaptureRecord, recordFileName } from './record.js';
import { existingEntry, reviewPrefix, workersPath } from './reviewDirectory.js';

interface EndpointRef {
  ref: string;
  name: string;
  commit: string;
}

interface ReviewDirectory {
  state: DirectoryState;
  lastWrite: number | undefined;
}

const listEndpointRefs = async (root: string): Promise<EndpointRef[]> => {
  const output = await readGit(root, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    `${refPrefix}${reviewPrefix}*`,
  ]);

  const lines = output.split('\n').filter((line) => line !== '');

  return lines.map((line) => {
    const [ref = '', commit = ''] = line.split(' ');

    return { ref, name: ref.slice(refPrefix.length), commit };
  });
};

const listWorktrees = async (root: string) => {
  const output = await readGit(root, ['worktree', 'list', '--porcelain', '-z']);

  return output
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length));
};

const workersFolder = (worktree: string) => join(worktree, '.tau', workersPath);

const modifiedAt = async (path: string) => {
  const entry = await existingEntry(path);

  return entry?.mtimeMs ?? 0;
};

const readDirectory = async (path: string): Promise<ReviewDirectory> => {
  if ((await existingEntry(join(path, recordFileName))) !== undefined) {
    return { state: 'record', lastWrite: undefined };
  }

  const directory = await existingEntry(path);

  if (directory === undefined) {
    return { state: 'absent', lastWrite: undefined };
  }

  const folderWrite = await modifiedAt(join(path, generationFolderName));

  return { state: 'noRecord', lastWrite: Math.max(directory.mtimeMs, folderWrite) };
};

const reviewDirectory = (worktree: string, name: string): Promise<ReviewDirectory> =>
  readDirectory(join(workersFolder(worktree), name)).catch(() => ({
    state: 'unknown' as const,
    lastWrite: undefined,
  }));

// A malformed record never reads as completed, so its predecessor needs no ref.
const parseTarget = (path: string, text: string) => {
  try {
    return parseCaptureRecord(path, text).target;
  } catch {
    return undefined;
  }
};

const readPredecessor = async (path: string) => {
  const text = await readFile(join(path, recordFileName), 'utf8').catch((error: unknown) => {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  });

  const target = text === undefined ? undefined : parseTarget(path, text);

  return target?.kind === 'fix' && target.predecessor !== undefined
    ? [basename(target.predecessor.review)]
    : [];
};

const listReviewNames = async (worktree: string) => {
  const names = await readdir(workersFolder(worktree)).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  });

  return names.filter((name) => name.startsWith(reviewPrefix));
};

const readPredecessors = async (worktrees: string[]): Promise<Set<string> | undefined> => {
  try {
    const found = await Promise.all(
      worktrees.map(async (worktree) => {
        const names = await listReviewNames(worktree);
        const paths = names.map((name) => join(workersFolder(worktree), name));
        const predecessors = await Promise.all(paths.map(readPredecessor));

        return predecessors.flat();
      }),
    );

    return new Set(found.flat());
  } catch {
    return undefined;
  }
};

const newestWrite = (directories: ReviewDirectory[]) => {
  const writes = directories.flatMap(({ lastWrite }) =>
    lastWrite === undefined ? [] : [lastWrite],
  );

  return writes.length === 0 ? undefined : Math.max(...writes);
};

const isPruned = async (
  worktrees: string[],
  predecessors: Set<string> | undefined,
  name: string,
  now: number,
) => {
  const directories = await Promise.all(
    worktrees.map((worktree) => reviewDirectory(worktree, name)),
  );

  const fixNeedsRef = predecessors?.has(name) ?? true;

  return decideEndpointPrune({
    directories: directories.map(({ state }) => state),
    lastWrite: newestWrite(directories),
    fixNeedsRef,
    now,
  });
};

// The old value makes Git delete the ref only while it still points at the listed commit. A ref
// that moved or is gone since the listing was handled by someone else.
const deleteRef = async (root: string, { ref, commit }: EndpointRef) => {
  const deleted = await runGit(root, ['update-ref', '--no-deref', '-d', ref, commit]);

  if (deleted.exitCode === 0) {
    return;
  }

  const current = await runGit(root, ['rev-parse', '--verify', '--quiet', ref]);

  if (current.stdout.toString('utf8').trim() === commit) {
    throw new Error(`git update-ref -d ${ref} failed: ${deleted.stderr.trim()}`);
  }
};

export const pruneEndpointRefs = async (root: string, now: number): Promise<void> => {
  const refs = await listEndpointRefs(root);
  const worktrees = await listWorktrees(root);
  const predecessors = await readPredecessors(worktrees);

  const decided = await Promise.all(
    refs.map(async (endpointRef) =>
      (await isPruned(worktrees, predecessors, endpointRef.name, now)) ? [endpointRef] : [],
    ),
  );

  for (const endpointRef of decided.flat()) {
    // oxlint-disable-next-line no-await-in-loop -- deleting a packed ref locks packed-refs, so parallel deletes would fail.
    await deleteRef(root, endpointRef);
  }
};
