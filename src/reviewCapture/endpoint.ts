import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage } from '../errors.js';
import { readGit, runGit } from '../git.js';
import { snapshotFolder } from './fixCapture.js';
import { isSupportedMode, shownBlobs } from './patchBlobs.js';
import type { ShownFile, ShownMode, SupportedMode } from './patchBlobs.js';
import { generationFolderName } from './record.js';
import type { Snapshot } from './record.js';

// A working tree input covers every capture with a verified snapshot, files targets included.
export type EndpointInput =
  | { kind: 'range'; from: string; to: string }
  | {
      kind: 'workingTree';
      directory: string;
      base: string;
      snapshot: Snapshot;
      patch: string;
    };

export type Endpoint =
  | { status: 'complete'; baseTree: string; tree: string }
  | { status: 'unsupported' | 'incomplete'; reasons: string[] };

export type EndpointComparison = 'equal' | 'different' | 'unknown';

type SnapshotInput = Extract<EndpointInput, { kind: 'workingTree' }>;

interface Limits {
  unsupported: string[];
  incomplete: string[];
}

interface IndexEntry {
  mode: SupportedMode;
  path: string;
}

const readTree = (root: string, revision: string) =>
  readGit(root, ['rev-parse', '--verify', `${revision}^{tree}`]);

const modeReason = (path: string, mode: ShownMode) => {
  if (mode === 'symlink') {
    return `${path} is a symbolic link, which the snapshot does not save.`;
  }

  if (mode === 'gitlink') {
    return `${path} is a submodule, which the snapshot does not save.`;
  }

  return `The captured patch shows a mode for ${path} that Tau cannot read.`;
};

// Skipped content the snapshot never held. An unreadable file may be saved by a later capture; a
// binary file, a submodule, a symbolic link, or an unknown mode cannot be.
const snapshotLimits = (snapshot: Snapshot, shown: Map<string, ShownFile>): Limits => {
  const limits: Limits = { unsupported: [], incomplete: [] };
  const skippedPaths = snapshot.skipped.map((entry) => entry.path);

  for (const entry of snapshot.skipped) {
    const reason = `The snapshot skipped ${entry.path} (${entry.kind}).`;

    if (entry.kind === 'unreadable') {
      limits.incomplete.push(reason);
    } else {
      limits.unsupported.push(reason);
    }
  }

  for (const path of [...snapshot.present, ...skippedPaths]) {
    const mode = shown.get(path)?.mode;

    if (mode !== undefined && !isSupportedMode(mode)) {
      limits.unsupported.push(modeReason(path, mode));
    }
  }

  return limits;
};

const baseMode = async (root: string, baseTree: string, path: string) => {
  const result = await runGit(root, ['ls-tree', '-z', '--full-tree', baseTree, '--', path]);

  if (result.exitCode !== 0) {
    throw new Error(`git ls-tree failed: ${result.stderr.trim()}`);
  }

  const [mode] = result.stdout.toString('utf8').split(' ');

  return mode === '100644' || mode === '100755' ? mode : undefined;
};

// A section that keeps the mode of a renamed file shows none, so the mode comes from the base.
const presentMode = async (
  root: string,
  baseTree: string,
  shown: Map<string, ShownFile>,
  path: string,
): Promise<SupportedMode | undefined> => {
  const file = shown.get(path);
  const mode = file?.mode;

  if (mode !== undefined) {
    return isSupportedMode(mode) ? mode : undefined;
  }

  return baseMode(root, baseTree, file?.source ?? path);
};

const presentEntries = async (
  root: string,
  baseTree: string,
  input: SnapshotInput,
  limits: Limits,
): Promise<IndexEntry[]> => {
  const shown = shownBlobs(input.patch);
  const entries: IndexEntry[] = [];

  for (const path of input.snapshot.present) {
    // oxlint-disable-next-line no-await-in-loop -- one Git process at a time.
    const mode = await presentMode(root, baseTree, shown, path);

    if (mode === undefined) {
      limits.unsupported.push(`Neither the captured patch nor the base shows a mode for ${path}.`);
    } else {
      entries.push({ mode, path });
    }
  }

  return entries;
};

// Hashes the saved copy as if it were checked in at its path, so Git applies the same check-in
// conversions a commit of the working tree file would.
const writeBlob = (root: string, directory: string, path: string) =>
  readGit(root, [
    'hash-object',
    '-w',
    `--path=${path}`,
    '--',
    join(directory, snapshotFolder, path),
  ]);

const indexInfo = async (
  root: string,
  input: SnapshotInput,
  baseTree: string,
  entries: IndexEntry[],
) => {
  const removedObject = '0'.repeat(baseTree.length);
  const lines = input.snapshot.absent.map((path) => `0 ${removedObject}\t${path}\0`);

  for (const entry of entries) {
    // oxlint-disable-next-line no-await-in-loop -- one Git process at a time.
    const blob = await writeBlob(root, input.directory, entry.path);

    lines.push(`${entry.mode} ${blob}\t${entry.path}\0`);
  }

  return lines.join('');
};

// The temporary index lives in its own folder, so removing the folder also removes a lock file
// that a failed Git command left behind. The user's index is never read or written.
const writeEndpointTree = async (
  root: string,
  directory: string,
  baseTree: string,
  info: string,
) => {
  const folder = await mkdtemp(join(directory, generationFolderName, 'endpoint-'));
  const environment = { GIT_INDEX_FILE: join(folder, 'index') };

  try {
    await readGit(root, ['read-tree', baseTree], { environment });
    await readGit(root, ['update-index', '-z', '--index-info'], { environment, input: info });

    return await readGit(root, ['write-tree'], { environment });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

const limitedEndpoint = (limits: Limits): Endpoint | undefined => {
  if (limits.unsupported.length > 0) {
    return { status: 'unsupported', reasons: [...limits.unsupported, ...limits.incomplete] };
  }

  if (limits.incomplete.length > 0) {
    return { status: 'incomplete', reasons: limits.incomplete };
  }

  return undefined;
};

const buildSnapshotEndpoint = async (root: string, input: SnapshotInput): Promise<Endpoint> => {
  const baseTree = await readTree(root, input.base);
  const limits = snapshotLimits(input.snapshot, shownBlobs(input.patch));
  const entries = await presentEntries(root, baseTree, input, limits);
  const limited = limitedEndpoint(limits);

  if (limited !== undefined) {
    return limited;
  }

  const info = await indexInfo(root, input, baseTree, entries);
  const tree = await writeEndpointTree(root, input.directory, baseTree, info);

  return { status: 'complete', baseTree, tree };
};

// The tree Git would commit for the reviewed content, and the tree it started from. A range names
// both trees already; a snapshot is laid over the base tree in a temporary index.
export const buildEndpoint = async (root: string, input: EndpointInput): Promise<Endpoint> => {
  try {
    if (input.kind === 'range') {
      const baseTree = await readTree(root, input.from);

      return { status: 'complete', baseTree, tree: await readTree(root, input.to) };
    }

    return await buildSnapshotEndpoint(root, input);
  } catch (error) {
    return { status: 'incomplete', reasons: [errorMessage(error)] };
  }
};

const objectExists = async (root: string, object: string) => {
  const result = await runGit(root, ['cat-file', '-e', object]);

  return result.exitCode === 0;
};

// Whether the commit holds exactly the endpoint content. Unknown when the endpoint is not complete
// or Git no longer has either tree.
export const compareEndpoint = async (
  root: string,
  endpoint: Endpoint,
  commit: string,
): Promise<EndpointComparison> => {
  if (endpoint.status !== 'complete') {
    return 'unknown';
  }

  const commitTree = `${commit}^{tree}`;

  const treesExist =
    (await objectExists(root, endpoint.tree)) && (await objectExists(root, commitTree));

  if (!treesExist) {
    return 'unknown';
  }

  const tree = await readTree(root, commit);

  return tree === endpoint.tree ? 'equal' : 'different';
};
