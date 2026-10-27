import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { errorMessage, hasErrorCode, isMissingFile } from '../errors.js';
import { runGit } from '../git.js';
import type { GitResult } from '../git.js';
import {
  captureTarget,
  captureWholeFile,
  diffArguments,
  emptyPart,
  excludedGaps,
  failure,
  fixedPrefixes,
  hashBytes,
  isBinaryDiff,
  isInsideRoot,
  runCaptureCommand,
  uniqueGaps,
  wholeFileList,
} from './capture.js';
import type { Capture, DirectTarget, Gap, Part } from './capture.js';
import { shownBlobs } from './patchBlobs.js';
import { readCaptureRecord, recordFileName } from './record.js';
import type { Snapshot } from './record.js';
import { checkReviewDirectory, existingEntry } from './reviewDirectory.js';
import type { PinnedTarget } from './target.js';

export type FixTarget = Extract<PinnedTarget, { kind: 'fix' }>;

export type FixReviewTarget = Omit<FixTarget, 'base'>;

type SnapshotTarget = Extract<DirectTarget, { kind: 'workingTree' | 'files' }>;

type SnapshotGapKind = Snapshot['skipped'][number]['kind'];

type WorkingFile = 'absent' | 'regular' | 'other';

interface Candidates {
  paths: string[];
  // Paths that differ from the pinned base now, before the earlier capture's paths are added.
  current: string[];
  gaps: Gap[];
  errors: string[];
}

type EarlierContent = { file: string } | { blob: { sha: string; mode: string } } | undefined;

interface FixContext {
  root: string;
  directory: string;
  scratch: string;
  target: SnapshotTarget;
  snapshot: Snapshot;
}

interface EarlierReview {
  target: DirectTarget;
  base: string | null;
  snapshot: Snapshot | undefined;
}

export const snapshotFolder = 'snapshot';

const executableMode = 0o755;

const regularMode = 0o644;

const isSnapshotTarget = (target: DirectTarget): target is SnapshotTarget =>
  target.kind === 'workingTree' || target.kind === 'files';

export const isRepositoryPath = (path: string): boolean => {
  const segments = path.split('/');

  return !isAbsolute(path) && !segments.includes('..') && !segments.includes('');
};

const readWorkingFile = async (root: string, path: string): Promise<WorkingFile> => {
  const file = join(root, path);

  try {
    const entry = await lstat(file);

    if (!entry.isFile()) {
      return 'other';
    }

    return (await isInsideRoot(root, file)) ? 'regular' : 'other';
  } catch (error) {
    if (isMissingFile(error) || hasErrorCode(error, 'ENOTDIR')) {
      return 'absent';
    }

    if (hasErrorCode(error, 'EACCES')) {
      return 'other';
    }

    throw error;
  }
};

const isSnapshotGapKind = (kind: Gap['kind']): kind is SnapshotGapKind =>
  kind === 'binary' || kind === 'unreadable' || kind === 'submodule';

// The blob Git would store for the working tree file, filters applied, or null when it cannot be
// read. A fix review compares it with the file now to see whether a skipped path changed.
const workingIdentity = async (root: string, path: string): Promise<string | null> => {
  if ((await readWorkingFile(root, path)) !== 'regular') {
    return null;
  }

  try {
    const result = await runGit(root, ['hash-object', `--path=${path}`, '--', join(root, path)]);
    const identity = result.stdout.toString('utf8').trim();

    return result.exitCode === 0 && identity !== '' ? identity : null;
  } catch {
    return null;
  }
};

const skippedPaths = (root: string, gaps: Gap[]): Promise<Snapshot['skipped']> =>
  Promise.all(
    gaps
      .flatMap((gap) => (isSnapshotGapKind(gap.kind) ? [{ kind: gap.kind, path: gap.path }] : []))
      .map(async (entry) => {
        const identity = await workingIdentity(root, entry.path);
        const existed = (await readWorkingFile(root, entry.path)) !== 'absent';

        return { kind: entry.kind, path: entry.path, identity, existed };
      }),
  );

// Copies the working tree content of each captured path into the review directory, so a later
// fix review can diff against what the reviewer saw. Removes the folder again when a copy fails.
const saveSnapshot = async (
  directory: string,
  root: string,
  captured: Capture,
): Promise<Snapshot> => {
  const folder = join(directory, snapshotFolder);
  const skipped = await skippedPaths(root, captured.gaps);
  const skippedSet = new Set(skipped.map((entry) => entry.path));
  const snapshot: Snapshot = { present: [], absent: [], skipped };

  await mkdir(folder);

  try {
    for (const path of captured.paths.filter((saved) => !skippedSet.has(saved))) {
      // oxlint-disable-next-line no-await-in-loop -- the files copy one at a time on purpose.
      const state = await readWorkingFile(root, path);

      if (state === 'absent') {
        snapshot.absent.push(path);
      } else if (state === 'other') {
        snapshot.skipped.push({ kind: 'unreadable', path, identity: null, existed: true });
      } else {
        // oxlint-disable-next-line no-await-in-loop -- see above.
        await mkdir(dirname(join(folder, path)), { recursive: true });
        // oxlint-disable-next-line no-await-in-loop -- see above.
        await copyFile(join(root, path), join(folder, path));
        snapshot.present.push(path);
      }
    }
  } catch (error) {
    await rm(folder, { recursive: true, force: true });

    throw error;
  }

  return snapshot;
};

const blobAt = async (root: string, base: string, path: string) => {
  const result = await runGit(root, ['ls-tree', '-z', '--full-tree', base, '--', path]);

  if (result.exitCode === null) {
    throw new Error(`git ls-tree failed: ${result.stderr.trim()}`);
  }

  const line = result.stdout.toString('utf8').split('\0')[0] ?? '';
  const [meta = ''] = line.split('\t');
  const [mode = '', type = '', sha = ''] = meta.split(' ');

  if (result.exitCode !== 0 || type !== 'blob' || mode === '120000') {
    return undefined;
  }

  return { sha, mode };
};

// The diff shows the blob after Git's check-in filters for the path, so the copy is hashed the same
// way.
const savedBlob = async (root: string, directory: string, path: string) => {
  const file = join(directory, snapshotFolder, path);
  const result = await runGit(root, ['hash-object', `--path=${path}`, '--', file]);

  return result.stdout.toString('utf8').trim();
};

// Checks every saved file against the blob the captured diff shows for it, or against the base
// blob when the diff shows no content change. This reads the saved copy itself, so an edit that
// was reverted before any recapture still fails, and a file that cannot be matched fails too.
export const verifySnapshot = async (
  root: string,
  directory: string,
  snapshot: Snapshot,
  captured: Capture,
  base: string,
): Promise<void> => {
  const shown = shownBlobs(captured.bytes.toString('utf8'));

  for (const path of snapshot.present) {
    const file = shown.get(path);
    const shownBlob = file?.blob;

    const source = file?.source ?? path;

    // oxlint-disable-next-line no-await-in-loop -- the files hash one at a time on purpose.
    const baseBlob = shownBlob === undefined ? await blobAt(root, base, source) : undefined;
    const expected = shownBlob ?? baseBlob?.sha;

    // oxlint-disable-next-line no-await-in-loop -- see above.
    const saved = expected === undefined ? undefined : await savedBlob(root, directory, path);

    if (expected === undefined || saved?.startsWith(expected) !== true) {
      throw new Error(
        `The saved copy of ${path} does not match the capture, so a fix review could not compare against it. Nothing was written. Capture again.`,
      );
    }
  }
};

// The snapshot must hold the bytes input.md shows. A recapture after the copy catches an edit that
// is still in the tree, and the saved copy check catches one that was already reverted.
export const saveVerifiedSnapshot = async (
  directory: string,
  root: string,
  pinned: SnapshotTarget,
  captured: Capture,
): Promise<Snapshot> => {
  const snapshot = await saveSnapshot(directory, root, captured);

  try {
    await verifySnapshot(root, directory, snapshot, captured, pinned.base);

    const again = await captureTarget(root, pinned);

    if (again.errors.length > 0 || again.hash !== captured.hash) {
      throw new Error(
        'The working tree changed while the snapshot was saved, so it would not match the capture. Nothing was written. Capture again.',
      );
    }

    return snapshot;
  } catch (error) {
    await rm(join(directory, snapshotFolder), { recursive: true, force: true });

    throw error;
  }
};

const versionOneMessage = (review: string) =>
  `${review} holds a version 1 capture record, which saved no snapshot. Capture the review again, then name that review.`;

const readEarlierReview = async (review: string): Promise<EarlierReview> => {
  if ((await existingEntry(join(review, recordFileName))) === undefined) {
    throw new Error(`${review} holds no capture record, so a fix review has nothing to compare.`);
  }

  const record = await readCaptureRecord(review);

  if (record.version === 1) {
    throw new Error(versionOneMessage(review));
  }

  const { target, snapshot, base } = record;

  if (target.kind === 'fix') {
    throw new Error(
      `${review} holds a fix capture. Name the review that the fix capture was made against.`,
    );
  }

  if (isSnapshotTarget(target) && snapshot === undefined) {
    throw new Error(`${review} holds a capture record with no snapshot.`);
  }

  return { target, base, snapshot };
};

const snapshotPaths = (snapshot: Snapshot) => [
  ...snapshot.present,
  ...snapshot.absent,
  ...snapshot.skipped.map((entry) => entry.path),
];

const rejectUnsafeSnapshot = async (review: string, snapshot: Snapshot | undefined) => {
  if (snapshot === undefined) {
    return;
  }

  const unsafe = snapshotPaths(snapshot).find((path) => !isRepositoryPath(path));

  if (unsafe !== undefined) {
    throw new Error(`The snapshot of ${review} names a path outside the repository: ${unsafe}`);
  }

  if ((await existingEntry(join(review, snapshotFolder))) === undefined) {
    throw new Error(`${review} holds a capture record but no ${snapshotFolder} folder.`);
  }
};

// Resolves the earlier review and keeps its base, so the fix capture reports the same base.
export const pinFixTarget = async (root: string, target: FixReviewTarget): Promise<FixTarget> => {
  const review = await checkReviewDirectory(root, target.review);
  const earlier = await readEarlierReview(review);

  await rejectUnsafeSnapshot(review, earlier.snapshot);

  return { ...target, review, base: earlier.base };
};

const nameOnlyPaths = async (root: string, target: SnapshotTarget) => {
  const command = diffArguments(target, ['--name-only', '-z', '--no-renames']);
  const listed = await runCaptureCommand(root, command);

  if (listed.stdout === undefined) {
    return { error: `git ${command.join(' ')} failed: ${listed.error}` };
  }

  return {
    paths: listed.stdout
      .toString('utf8')
      .split('\0')
      .filter((path) => path !== ''),
  };
};

const nameOf = (path: string) => (path.endsWith('/') ? path.slice(0, -1) : path);

const nests = (first: string, second: string) =>
  first.startsWith(`${second}/`) || second.startsWith(`${first}/`);

// A directory and a file of the same name cannot exist together, so such paths match in
// separate groups.
const groupWithoutNesting = (paths: string[]) => {
  const groups: string[][] = [];

  for (const path of paths) {
    const group = groups.find(
      (members) => !members.some((member) => nests(nameOf(member), nameOf(path))),
    );

    if (group === undefined) {
      groups.push([path]);
    } else {
      group.push(path);
    }
  }

  return groups;
};

const keepNotExcludedInGroup = async (paths: string[], exclude: readonly string[]) => {
  const scratch = await mkdtemp(join(tmpdir(), 'tau-fix-match-'));

  try {
    await runGit(scratch, ['init', '--quiet']);

    for (const path of paths) {
      // oxlint-disable-next-line no-await-in-loop -- the files are created one at a time on purpose.
      await mkdir(dirname(join(scratch, nameOf(path))), { recursive: true });
      // oxlint-disable-next-line no-await-in-loop -- see above.
      await writeFile(join(scratch, nameOf(path)), '');
    }

    const spec = exclude.map((path) => `:(exclude)${path}`);
    const listed = await runGit(scratch, ['ls-files', '-z', '-o', '--', ...spec]);

    if (listed.exitCode !== 0) {
      throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
    }

    const kept = new Set(listed.stdout.toString('utf8').split('\0'));

    return paths.filter((path) => kept.has(nameOf(path)));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

// Git matches the exclude pathspecs against empty files laid out in a scratch repository, so a
// deleted path follows the same rules as the rest of the capture.
const keepNotExcluded = async (paths: string[], exclude: readonly string[]): Promise<string[]> => {
  if (exclude.length === 0 || paths.length === 0) {
    return paths;
  }

  const kept = new Set<string>();

  for (const group of groupWithoutNesting(paths)) {
    // oxlint-disable-next-line no-await-in-loop -- one scratch repository at a time.
    for (const path of await keepNotExcludedInGroup(group, exclude)) {
      kept.add(path);
    }
  }

  return paths.filter((path) => kept.has(path));
};

// The paths that may differ from the earlier capture: everything that differs from the pinned base
// now, whatever files the earlier target named, plus every path the earlier capture saw or skipped.
const findCandidates = async (
  root: string,
  target: SnapshotTarget,
  snapshot: Snapshot,
): Promise<Candidates> => {
  const exclude = target.exclude ?? [];
  const everything: SnapshotTarget = { kind: 'workingTree', base: target.base, exclude };
  const changed = await nameOnlyPaths(root, everything);
  const listed = await wholeFileList(everything, root);

  if (changed.paths === undefined) {
    return { paths: [], current: [], gaps: [], errors: [changed.error] };
  }

  if (listed.files === undefined) {
    return { paths: [], current: [], gaps: [], errors: [listed.error] };
  }

  const gaps = listed.unreadable.map((path) => ({ kind: 'unreadable' as const, path }));
  const earlier = [...snapshot.present, ...snapshot.absent, ...snapshot.skipped.map((s) => s.path)];
  const all = [...new Set([...changed.paths, ...listed.files, ...earlier])].toSorted();

  const current = [...changed.paths, ...listed.files];

  return { paths: await keepNotExcluded(all, exclude), current, gaps, errors: [] };
};

const earlierContent = async (
  root: string,
  directory: string,
  target: SnapshotTarget,
  snapshot: Snapshot,
  path: string,
): Promise<EarlierContent> => {
  if (snapshot.present.includes(path)) {
    return { file: join(directory, snapshotFolder, path) };
  }

  if (snapshot.absent.includes(path)) {
    return undefined;
  }

  const blob = await blobAt(root, target.base, path);

  return blob === undefined ? undefined : { blob };
};

const writeEarlier = async (
  root: string,
  content: NonNullable<EarlierContent>,
  destination: string,
) => {
  await mkdir(dirname(destination), { recursive: true });

  if ('file' in content) {
    await copyFile(content.file, destination);

    return;
  }

  const blob = await runGit(root, ['cat-file', 'blob', content.blob.sha]);

  if (blob.exitCode !== 0) {
    throw new Error(`git cat-file blob ${content.blob.sha} failed: ${blob.stderr.trim()}`);
  }

  const mode = content.blob.mode === '100755' ? executableMode : regularMode;

  await writeFile(destination, blob.stdout, { mode });
};

const diffPart = (path: string, result: GitResult, command: string[]): Part => {
  if (result.exitCode === null || result.exitCode > 1 || result.stderr.trim() !== '') {
    return failure(command, `exit ${result.exitCode}: ${result.stderr.trim()}`);
  }

  if (result.stdout.length === 0) {
    return emptyPart;
  }

  const gaps = isBinaryDiff(result.stdout) ? [{ kind: 'binary' as const, path }] : [];

  return { bytes: result.stdout, paths: [path], gaps, errors: [] };
};

const runNoIndexDiff = async (cwd: string, path: string, files: string[], prefixes: string[]) => {
  const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-index', ...prefixes];
  const command = ['diff', ...options, '--', ...files];

  return diffPart(path, await runGit(cwd, command), command);
};

const comparePath = async (context: FixContext, path: string): Promise<Part> => {
  const { root, directory, scratch, target, snapshot } = context;
  const current = await readWorkingFile(root, path);

  if (current === 'other') {
    return { ...emptyPart, gaps: [{ kind: 'unreadable', path }] };
  }

  const earlier = await earlierContent(root, directory, target, snapshot, path);

  if (earlier === undefined) {
    return current === 'absent' ? emptyPart : captureWholeFile(root, path, new Set());
  }

  const earlierFile = join(scratch, 'a', path);

  await writeEarlier(root, earlier, earlierFile);

  if (current === 'absent') {
    return runNoIndexDiff(join(scratch, 'a'), path, [path, '/dev/null'], fixedPrefixes);
  }

  await mkdir(dirname(join(scratch, 'b', path)), { recursive: true });
  await copyFile(join(root, path), join(scratch, 'b', path));

  return runNoIndexDiff(scratch, path, [join('a', path), join('b', path)], ['--no-prefix']);
};

const skippedGaps = (snapshot: Snapshot, paths: readonly string[]): Gap[] =>
  snapshot.skipped
    .filter((entry) => paths.includes(entry.path))
    .map((entry) => ({ kind: entry.kind, path: entry.path }));

const comparePaths = async (context: FixContext, paths: string[]) => {
  const parts: Part[] = [];

  // One Git process at a time keeps a large untracked tree from starting thousands at once.
  for (const path of paths) {
    if (path.endsWith('/')) {
      parts.push({ ...emptyPart, gaps: [{ kind: 'submodule', path: path.slice(0, -1) }] });
    } else if (!context.snapshot.skipped.some((entry) => entry.path === path)) {
      // oxlint-disable-next-line no-await-in-loop -- the files run one at a time on purpose.
      parts.push(await comparePath(context, path));
    }
  }

  return parts;
};

const gapChangeKinds = new Set<Gap['kind']>(['binary', 'unreadable', 'submodule']);

// A skipped path counts as changed when its identity differs from the one saved at capture time.
// Other gap paths count when they differ from the base now or no longer exist.
const skippedChanged = async (root: string, entry: Snapshot['skipped'][number]) => {
  const state = await readWorkingFile(root, entry.path);

  if (state === 'absent') {
    return entry.existed;
  }

  const identity = await workingIdentity(root, entry.path);

  return identity === null || identity !== entry.identity;
};

const changedPaths = async (
  root: string,
  paths: string[],
  gaps: Gap[],
  candidates: Candidates,
  snapshot: Snapshot,
): Promise<string[]> => {
  const current = new Set(candidates.current.map(nameOf));
  const skipped = new Map(snapshot.skipped.map((entry) => [entry.path, entry]));
  const gapPaths = gaps.filter((gap) => gapChangeKinds.has(gap.kind)).map((gap) => gap.path);

  const flags = await Promise.all(
    gapPaths.map(async (path) => {
      const entry = skipped.get(path);

      if (entry !== undefined) {
        return skippedChanged(root, entry);
      }

      return current.has(path) || (await readWorkingFile(root, path)) === 'absent';
    }),
  );

  const changed = gapPaths.filter((_, index) => flags[index] === true);

  return [...new Set([...paths, ...changed])].toSorted();
};

const captureAgainstSnapshot = async (
  root: string,
  fix: FixTarget,
  earlier: SnapshotTarget,
  snapshot: Snapshot,
): Promise<Capture> => {
  const exclude = [...(earlier.exclude ?? []), ...(fix.exclude ?? [])];
  const target: SnapshotTarget = { ...earlier, exclude };
  const candidates = await findCandidates(root, target, snapshot);
  const scratch = await mkdtemp(join(tmpdir(), 'tau-fix-'));

  try {
    const context = { root, directory: fix.review, scratch, target, snapshot };
    const compared = await comparePaths(context, candidates.paths);
    const parts = [{ ...emptyPart, gaps: candidates.gaps, errors: candidates.errors }, ...compared];
    const bytes = Buffer.concat(parts.map((part) => part.bytes));
    const hashed = await hashBytes(root, bytes);
    const paths = [...new Set(parts.flatMap((part) => part.paths))].toSorted();
    const errors = parts.flatMap((part) => part.errors);

    const gaps = uniqueGaps([
      ...parts.flatMap((part) => part.gaps),
      ...skippedGaps(snapshot, candidates.paths),
      ...excludedGaps({ exclude }),
    ]);

    if (hashed.error !== undefined) {
      errors.push(hashed.error);
    }

    const changed = await changedPaths(root, paths, gaps, candidates, snapshot);

    return { bytes, hash: hashed.hash ?? '', paths, changed, gaps, errors };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

const unsnapshottedBase = (earlier: Exclude<DirectTarget, SnapshotTarget>) =>
  earlier.kind === 'range' ? earlier.to : earlier.commit;

// The diff from the earlier capture to the working tree. A range or root commit review needs no
// snapshot: its pinned commit is the earlier content.
export const captureFixTarget = async (root: string, fix: FixTarget): Promise<Capture> => {
  try {
    const { target: earlier, snapshot } = await readEarlierReview(fix.review);

    if (isSnapshotTarget(earlier)) {
      if (snapshot === undefined) {
        throw new Error(`${fix.review} holds a capture record with no snapshot.`);
      }

      return await captureAgainstSnapshot(root, fix, earlier, snapshot);
    }

    const exclude = [...(earlier.exclude ?? []), ...(fix.exclude ?? [])];
    const base = unsnapshottedBase(earlier);

    return await captureTarget(root, { kind: 'workingTree', base, exclude });
  } catch (error) {
    const message = errorMessage(error);

    return { bytes: Buffer.alloc(0), hash: '', paths: [], gaps: [], errors: [message] };
  }
};
