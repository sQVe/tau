import { runGit } from '../git.js';
import { readRawRecords } from './capture.js';
import type { RawRecord } from './capture.js';
import { shownBlobs } from './patchBlobs.js';
import type { ShownFile, ShownMode } from './patchBlobs.js';

interface EndpointTrees {
  baseTree: string;
  tree: string;
}

export const baseEntry = async (
  root: string,
  baseTree: string,
  path: string,
): Promise<{ mode: string; blob: string }> => {
  const result = await runGit(root, [
    'ls-tree',
    '-z',
    '--full-tree',
    baseTree,
    '--',
    `:(literal)${path}`,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`git ls-tree failed: ${result.stderr.trim()}`);
  }

  const [mode = '', , blob = ''] = result.stdout.toString('utf8').split('\t')[0]?.split(' ') ?? [];

  return { mode, blob };
};

const shownModeText: Record<ShownMode, string> = {
  '100644': '100644',
  '100755': '100755',
  symlink: '120000',
  gitlink: '160000',
  unreadable: 'unreadable',
};

const deletedBlob = /^0+$/;

export const treeChanges = async (root: string, endpoint: EndpointTrees): Promise<RawRecord[]> => {
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

const shownPostImage = async (root: string, baseTree: string, file: ShownFile) => {
  const base =
    file.blob === undefined || file.mode === undefined
      ? await baseEntry(root, baseTree, file.source)
      : undefined;

  const mode = file.mode === undefined ? base?.mode : shownModeText[file.mode];

  return { blob: file.blob ?? base?.blob ?? '', mode };
};

const renamedSources = (shown: Map<string, ShownFile>) =>
  new Set(
    [...shown].flatMap(([path, file]) =>
      file.source === path || file.copied ? [] : [file.source],
    ),
  );

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

export const checkTransition = async (
  root: string,
  endpoint: EndpointTrees,
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
