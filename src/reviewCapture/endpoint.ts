import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage } from '../errors.js';
import { readGit, runGit } from '../git.js';
import { readRawRecords } from './capture.js';
import type { Gap, RawRecord } from './capture.js';
import { decideEndpoint } from './endpointDecision.js';
import type { SnapshotFacts } from './endpointDecision.js';
import { snapshotFolder } from './fixCapture.js';
import type { EndpointFacts } from './generationDecision.js';
import { isSupportedMode, shownBlobs } from './patchBlobs.js';
import type { ShownFile, ShownMode, SupportedMode } from './patchBlobs.js';
import { generationFolderName } from './record.js';
import type { Snapshot } from './record.js';
import type { PinnedTarget } from './target.js';

export interface EndpointCapture {
  directory: string;
  target: PinnedTarget;
  gaps: Gap[];
  patch: Buffer;
  snapshot: Snapshot | undefined;
}

export type Endpoint =
  | { status: 'complete'; baseTree: string; tree: string }
  | { status: 'unsupported' | 'incomplete'; reasons: string[] };

export type EndpointComparison = 'equal' | 'different' | 'unknown';

export interface SavedEndpoint {
  target: PinnedTarget;
  endpoint: Endpoint | undefined;
}

type CompleteEndpoint = Extract<Endpoint, { status: 'complete' }>;

type WorkingTreeTarget = Extract<PinnedTarget, { kind: 'workingTree' }>;

interface SnapshotBase extends SnapshotFacts {
  baseTree: string;
  snapshot: Snapshot;
}

interface IndexEntry {
  mode: SupportedMode;
  path: string;
}

const readTree = (root: string, revision: string) =>
  readGit(root, ['rev-parse', '--verify', `${revision}^{tree}`]);

const baseEntry = async (root: string, baseTree: string, path: string) => {
  const result = await runGit(root, ['ls-tree', '-z', '--full-tree', baseTree, '--', path]);

  if (result.exitCode !== 0) {
    throw new Error(`git ls-tree failed: ${result.stderr.trim()}`);
  }

  const [mode = '', , blob = ''] = result.stdout.toString('utf8').split('\t')[0]?.split(' ') ?? [];

  return { mode, blob };
};

const baseMode = async (root: string, baseTree: string, path: string) => {
  const { mode } = await baseEntry(root, baseTree, path);

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

const shownModes = (snapshot: Snapshot, shown: Map<string, ShownFile>) => {
  const skippedPaths = snapshot.skipped.map((entry) => entry.path);

  return [...snapshot.present, ...skippedPaths].flatMap((path) => {
    const mode = shown.get(path)?.mode;

    return mode === undefined ? [] : [{ path, mode }];
  });
};

// Only a working tree target lays its snapshot over the base, so only its snapshot is read.
const readSnapshotBase = async (
  root: string,
  target: WorkingTreeTarget,
  capture: EndpointCapture,
): Promise<SnapshotBase | undefined> => {
  const { snapshot } = capture;

  if (snapshot === undefined) {
    return undefined;
  }

  const baseTree = await readTree(root, target.base);
  const shown = shownBlobs(capture.patch.toString('utf8'));
  const presentModes: SnapshotFacts['presentModes'] = [];

  for (const path of snapshot.present) {
    // oxlint-disable-next-line no-await-in-loop -- one Git process at a time.
    presentModes.push({ path, mode: await presentMode(root, baseTree, shown, path) });
  }

  return {
    baseTree,
    snapshot,
    skipped: snapshot.skipped,
    shownModes: shownModes(snapshot, shown),
    presentModes,
  };
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

const indexInfo = async (root: string, directory: string, base: SnapshotBase) => {
  const removedObject = '0'.repeat(base.baseTree.length);
  const lines = base.snapshot.absent.map((path) => `0 ${removedObject}\t${path}\0`);

  const entries: IndexEntry[] = base.presentModes.flatMap(({ path, mode }) =>
    mode === undefined ? [] : [{ path, mode }],
  );

  for (const entry of entries) {
    // oxlint-disable-next-line no-await-in-loop -- one Git process at a time.
    const blob = await writeBlob(root, directory, entry.path);

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

const writeSnapshotEndpoint = async (
  root: string,
  directory: string,
  base: SnapshotBase,
): Promise<Endpoint> => {
  const info = await indexInfo(root, directory, base);
  const tree = await writeEndpointTree(root, directory, base.baseTree, info);

  return { status: 'complete', baseTree: base.baseTree, tree };
};

const writeEndpoint = async (
  root: string,
  capture: EndpointCapture,
  base: SnapshotBase | undefined,
): Promise<Endpoint> => {
  const { target } = capture;

  if (base !== undefined) {
    return writeSnapshotEndpoint(root, capture.directory, base);
  }

  if (target.kind !== 'range') {
    throw new Error(`A ${target.kind} capture without a snapshot records no endpoint.`);
  }

  const baseTree = await readTree(root, target.from);

  return { status: 'complete', baseTree, tree: await readTree(root, target.to) };
};

// The tree Git would commit for the reviewed content, and the tree it started from. A range names
// both trees already; a snapshot is laid over the base tree in a temporary index.
export const buildEndpoint = async (root: string, capture: EndpointCapture): Promise<Endpoint> => {
  const { target } = capture;

  try {
    const base =
      target.kind === 'workingTree' ? await readSnapshotBase(root, target, capture) : undefined;

    const eligibility = decideEndpoint({ target: target.kind, gaps: capture.gaps, snapshot: base });

    if (eligibility.status !== 'eligible') {
      return eligibility;
    }

    return await writeEndpoint(root, capture, base);
  } catch (error) {
    return { status: 'incomplete', reasons: [errorMessage(error)] };
  }
};

const objectExists = async (root: string, object: string) => {
  const result = await runGit(root, ['cat-file', '-e', object]);

  return result.exitCode === 0;
};

const shownModeText: Record<ShownMode, string> = {
  '100644': '100644',
  '100755': '100755',
  symlink: '120000',
  gitlink: '160000',
  unreadable: 'unreadable',
};

const deletedBlob = /^0+$/;

const treeChanges = async (root: string, endpoint: CompleteEndpoint): Promise<RawRecord[]> => {
  const result = await runGit(root, [
    'diff-tree',
    '-r',
    '-z',
    '--no-renames',
    endpoint.baseTree,
    endpoint.tree,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`git diff-tree failed: ${result.stderr.trim()}`);
  }

  return readRawRecords(result.stdout).records;
};

// A section with no index line or no mode keeps that part of its source in the base tree.
const shownPostImage = async (root: string, baseTree: string, file: ShownFile) => {
  const base =
    file.blob === undefined || file.mode === undefined
      ? await baseEntry(root, baseTree, file.source)
      : undefined;

  const mode = file.mode === undefined ? base?.mode : shownModeText[file.mode];

  return { blob: file.blob ?? base?.blob ?? '', mode };
};

// A rename shows only its new path, so its old path is deleted in the trees without its own section.
const renamedSources = (shown: Map<string, ShownFile>) =>
  new Set([...shown].flatMap(([path, file]) => (file.source === path ? [] : [file.source])));

const deletionMismatch = (path: string, file: ShownFile | undefined, sources: Set<string>) => {
  if (file === undefined) {
    return sources.has(path)
      ? undefined
      : `The endpoint deletes ${path}, which the captured patch does not show.`;
  }

  return deletedBlob.test(file.blob ?? '')
    ? undefined
    : `The endpoint deletes ${path}, which the captured patch does not delete.`;
};

const postImageMismatch = async (
  root: string,
  baseTree: string,
  file: ShownFile | undefined,
  change: RawRecord,
) => {
  const path = change.paths[0] ?? '';

  if (file === undefined) {
    return `The endpoint changes ${path}, which the captured patch does not show.`;
  }

  const expected = await shownPostImage(root, baseTree, file);
  const sameBlob = expected.blob !== '' && change.blob.startsWith(expected.blob);

  return sameBlob && change.newMode === expected.mode
    ? undefined
    : `The endpoint holds ${change.newMode} ${change.blob} at ${path}, not what the captured patch shows.`;
};

// Checks that the change from baseTree to tree is the change the saved patch shows: the same paths,
// and each new blob and mode as the patch shows them. Returns each difference.
export const checkTransition = async (
  root: string,
  endpoint: CompleteEndpoint,
  patch: string,
): Promise<string[]> => {
  const shown = shownBlobs(patch);
  const sources = renamedSources(shown);
  const changes = await treeChanges(root, endpoint);
  const changedPaths = new Set(changes.map((change) => change.paths[0] ?? ''));
  const mismatches: (string | undefined)[] = [];

  for (const change of changes) {
    const path = change.paths[0] ?? '';
    const file = shown.get(path);

    if (change.status === 'D') {
      mismatches.push(deletionMismatch(path, file, sources));
    } else {
      // oxlint-disable-next-line no-await-in-loop -- one Git process at a time.
      mismatches.push(await postImageMismatch(root, endpoint.baseTree, file, change));
    }
  }

  for (const path of shown.keys()) {
    if (!changedPaths.has(path)) {
      mismatches.push(`The captured patch shows ${path}, which the endpoint does not change.`);
    }
  }

  return mismatches.filter((mismatch) => mismatch !== undefined);
};

const missingTrees = async (root: string, endpoint: CompleteEndpoint) => {
  const trees = [endpoint.baseTree, endpoint.tree];
  const present = await Promise.all(trees.map((tree) => objectExists(root, tree)));

  return trees.flatMap((tree, index) =>
    present[index] === true ? [] : [`Git no longer has the endpoint tree ${tree}.`],
  );
};

const missingBlobs = async (root: string, blobs: string[]) => {
  const result = await runGit(root, ['cat-file', '--batch-check'], {
    input: blobs.map((blob) => `${blob}\n`).join(''),
  });

  if (result.exitCode !== 0) {
    throw new Error(`git cat-file failed: ${result.stderr.trim()}`);
  }

  return result.stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line.endsWith(' missing'))
    .map((line) => `Git no longer has the endpoint blob ${line.split(' ')[0] ?? ''}.`);
};

// A raw tree diff reads no blob, so each blob the endpoint adds or changes is checked on its own.
const missingObjects = async (root: string, endpoint: CompleteEndpoint): Promise<string[]> => {
  const trees = await missingTrees(root, endpoint);

  if (trees.length > 0) {
    return trees;
  }

  try {
    const changes = await treeChanges(root, endpoint);

    const blobs = changes.filter((change) => change.status !== 'D').map((change) => change.blob);

    return await missingBlobs(root, blobs);
  } catch (error) {
    return [`Git could not compare the endpoint trees: ${errorMessage(error)}`];
  }
};

// Whether the commit holds exactly the endpoint content. Unknown when the endpoint is not complete
// or Git no longer has its objects or the commit tree.
export const compareEndpoint = async (
  root: string,
  endpoint: Endpoint,
  commit: string,
): Promise<EndpointComparison> => {
  if (endpoint.status !== 'complete') {
    return 'unknown';
  }

  const commitTreeExists = await objectExists(root, `${commit}^{tree}`);

  if (!commitTreeExists) {
    return 'unknown';
  }

  const missing = await missingObjects(root, endpoint);

  if (missing.length > 0) {
    return 'unknown';
  }

  const tree = await readTree(root, commit);

  return tree === endpoint.tree ? 'equal' : 'different';
};

const treeMismatch = (name: string, recorded: string, pinned: string, commit: string) =>
  recorded === pinned
    ? []
    : [
        `The endpoint ${name} is ${recorded}, not the tree ${pinned} of the pinned commit ${commit}.`,
      ];

// Checks that the endpoint starts from the tree of the target's pinned base and, for a range, ends
// at the tree of its pinned end. Another pair with the same change would hide other content.
export const checkBinding = async (
  root: string,
  endpoint: CompleteEndpoint,
  target: PinnedTarget,
): Promise<string[]> => {
  if (target.kind === 'range') {
    return [
      ...treeMismatch(
        'base tree',
        endpoint.baseTree,
        await readTree(root, target.from),
        target.from,
      ),
      ...treeMismatch('tree', endpoint.tree, await readTree(root, target.to), target.to),
    ];
  }

  if (target.kind === 'workingTree') {
    return treeMismatch(
      'base tree',
      endpoint.baseTree,
      await readTree(root, target.base),
      target.base,
    );
  }

  return [`A ${target.kind} capture records no complete endpoint.`];
};

// What Git shows of a saved endpoint now. The transition is checked only when Git has every object
// of the endpoint and the saved patch could be read.
const observeEndpoint = async (
  root: string,
  endpoint: Endpoint,
  target: PinnedTarget,
  patch: Buffer | undefined,
): Promise<EndpointFacts> => {
  const observation: EndpointFacts = { status: endpoint.status, missing: [], mismatches: [] };

  if (endpoint.status !== 'complete') {
    return observation;
  }

  observation.missing = await missingObjects(root, endpoint);

  if (observation.missing.length > 0) {
    return observation;
  }

  try {
    observation.mismatches = await checkBinding(root, endpoint, target);

    if (patch !== undefined) {
      observation.mismatches.push(
        ...(await checkTransition(root, endpoint, patch.toString('utf8'))),
      );
    }
  } catch (error) {
    observation.missing = [`Git could not compare the endpoint trees: ${errorMessage(error)}`];
  }

  return observation;
};

export const observeSavedEndpoint = async (
  root: string,
  saved: SavedEndpoint | undefined,
  patch: Buffer | undefined,
): Promise<EndpointFacts | undefined> =>
  saved?.endpoint === undefined
    ? undefined
    : observeEndpoint(root, saved.endpoint, saved.target, patch);
