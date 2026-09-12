import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { reviewGit } from './commentReview.js';
import { gitBytes, indexIdentity, readWorkingEntry, snapshotPreparation } from './preparation.js';
import type { WorkingEntry } from './preparation.js';

type Git = Pick<ExtensionAPI, 'exec'>;
type Working = Record<string, WorkingEntry>;
const maximumBytes = 300 * 1024 * 1024;
const workingSchema = Type.Record(
  Type.String(),
  Type.Union([
    Type.Null(),
    Type.Object(
      {
        kind: Type.Union([Type.Literal('file'), Type.Literal('symlink')]),
        mode: Type.Integer(),
        content: Type.String(),
      },
      { additionalProperties: false },
    ),
  ]),
);
const parseWorking = (bytes: Buffer): Working => {
  const value: unknown = JSON.parse(bytes.toString());

  if (!Value.Check(workingSchema, value)) {
    throw new Error('Invalid working backup');
  }

  return value;
};
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const optionalStatus = async (path: string) =>
  lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });
const sync = async (path: string) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const save = async (path: string, bytes: Buffer | string) => {
  const handle = await open(path, 'wx', 0o600);

  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const read = async (path: string, synchronize = false) => {
  // A corrupt backup may be a FIFO. Open without waiting, then reject anything but a regular file.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const status = await handle.stat();

    if (!status.isFile() || status.nlink !== 1 || status.size > maximumBytes) {
      throw new Error(`Unsupported recovery file: ${path}`);
    }

    const content = await handle.readFile();

    if (synchronize) {
      await handle.sync();
    }

    return content;
  } finally {
    await handle.close();
  }
};
const readIndex = async (gitDirectory: string) => {
  const path = join(gitDirectory, 'index');

  return (await optionalStatus(path)) ? read(path) : null;
};
const recoveryPaths = (gitDirectory: string) => {
  const directory = join(gitDirectory, 'tau-recovery');

  return { directory, pending: join(directory, 'pending') };
};
const requireDirectory = async (path: string) => {
  const status = await lstat(path);

  if (!status.isDirectory()) {
    throw new Error(`Unsafe recovery directory: ${path}`);
  }
};

export const assertNoPendingRecovery = async (gitDirectory: string) => {
  const { directory, pending } = recoveryPaths(gitDirectory);

  try {
    const status = await optionalStatus(directory);

    if (status && !status.isDirectory()) {
      throw new Error('Unsafe recovery directory');
    }

    if (await optionalStatus(pending)) {
      throw new Error('Pending recovery');
    }
  } catch (error) {
    throw new Error(`Commit blocked. Inspect recovery data at ${directory}. ${String(error)}`, {
      cause: error,
    });
  }
};

const validateWorking = (working: Working) => {
  let bytes = 0;

  for (const [path, entry] of Object.entries(working)) {
    if (
      !path ||
      posix.normalize(path) !== path ||
      isAbsolute(path) ||
      path.startsWith('../') ||
      path === '.' ||
      path === '..' ||
      path.split('/').includes('.git') ||
      path.includes('\0')
    ) {
      throw new Error(`Unsupported recovery path: ${JSON.stringify(path)}`);
    }

    if (entry === null) {
      continue;
    }

    if (
      !entry ||
      !['file', 'symlink'].includes(entry.kind) ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777 ||
      typeof entry.content !== 'string' ||
      Buffer.from(entry.content, 'base64').toString('base64') !== entry.content
    ) {
      throw new Error(`Unsupported recovery entry: ${JSON.stringify(path)}`);
    }

    const content = Buffer.from(entry.content, 'base64');
    bytes += content.length;

    if (
      entry.kind === 'symlink' &&
      (entry.mode !== 0o777 || content.includes(0) || !content.length)
    ) {
      throw new Error(`Unsupported symlink: ${JSON.stringify(path)}`);
    }
  }

  if (bytes > 100 * 1024 * 1024) {
    throw new Error('Recovery exceeds 100 MiB');
  }
};
const parents = async (root: string, path: string) => {
  let parent = dirname(join(root, path));

  while (parent !== root) {
    // Missing parents and directory transitions need a directory snapshot, which this slice does not own.
    await requireDirectory(parent);
    parent = dirname(parent);
  }

  await requireDirectory(root);
};
const supportedWorking = async (root: string, working: Working) => {
  validateWorking(working);

  for (const path of Object.keys(working)) {
    await parents(root, path);

    const status = await optionalStatus(join(root, path));

    if (status && status.nlink !== 1) {
      throw new Error(`Unsupported hardlink: ${JSON.stringify(path)}`);
    }
  }
};
const syncTree = async (directory: string) => {
  await requireDirectory(directory);

  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const status = await lstat(path);

    if (status.isDirectory()) {
      await syncTree(path);
    } else if (status.isFile() && status.nlink === 1) {
      await sync(path);
    } else {
      throw new Error(`Unsupported Git storage: ${path}`);
    }
  }

  await sync(directory);
};
const saveIndexObjects = async (root: string, commonDirectory: string, tree: string) => {
  const objects = join(commonDirectory, 'objects');
  const packs = join(objects, 'pack');
  await requireDirectory(objects);

  if (await optionalStatus(join(objects, 'info/alternates'))) {
    throw new Error('External Git object storage is unsupported');
  }

  await mkdir(packs, { recursive: true });
  await requireDirectory(packs);
  // A tree has no prerequisite history. Git writes a self-contained pack and keeps object lookup native.
  const output = await gitBytes(
    root,
    ['pack-objects', '--revs', '--no-use-bitmap-index', join(packs, 'pack')],
    undefined,
    `${tree}\n`,
  );
  const identifier = output.toString().trim();

  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(identifier)) {
    throw new Error('Invalid recovery pack identifier');
  }

  const pack = join(packs, `pack-${identifier}`);
  await sync(`${pack}.pack`);
  await sync(`${pack}.idx`);
  await sync(packs);
  await sync(objects);
  await gitBytes(root, ['verify-pack', `${pack}.idx`]);
};

const head = async (root: string) => {
  try {
    return (await gitBytes(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).toString().trim();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) {
      return null;
    }

    throw error;
  }
};

// Freeze exclusions before hiding ignore files. Installed dependencies remain outside coverage.
const ignoredPaths = async (root: string) =>
  new TextDecoder('utf-8', { fatal: true })
    .decode(
      await gitBytes(root, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
      ]),
    )
    .split('\0')
    .filter(Boolean);

// Freeze external exclude rules so a checker's later edits to them cannot hide new work.
// Git reads the global file first and info/exclude second; the last matching pattern wins.
// Both are read before any checker runs, and git follows the same symlinks, so plain reads suffice.
const externalExcludes = async (root: string) => {
  const infoExclude = (
    await gitBytes(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])
  )
    .toString()
    .trim();
  const globalExclude = await gitBytes(root, ['config', '--path', '--get', 'core.excludesFile'])
    .then((bytes) => bytes.toString().trim())
    .catch(() => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'git/ignore'));
  const contents = await Promise.all(
    [globalExclude, infoExclude].map((path) =>
      readFile(isAbsolute(path) ? path : join(root, path), 'utf8').catch(() => ''),
    ),
  );

  return contents.map((content) => `${content}\n`).join('');
};

const isExcluded = (path: string, ignored: string[]) =>
  ignored.some(
    (excluded) =>
      path === excluded ||
      `${path}/` === excluded ||
      (excluded.endsWith('/') && path.startsWith(excluded)),
  );
const isIgnoreFile = (path: string) => path === '.gitignore' || path.endsWith('/.gitignore');
export const newIgnoredArtifacts = async (
  root: string,
  expected: Working,
  untouched?: Working,
  originalIgnored: string[] = [],
  excludes = '',
) => {
  const knownPaths = Object.keys(expected);
  const ignoreFiles = knownPaths.filter(isIgnoreFile);
  let matchesExpected = true;
  let matchesUntouched = untouched !== undefined;

  for (const path of ignoreFiles) {
    const { entry } = await readWorkingEntry(root, path);
    matchesExpected &&= isDeepStrictEqual(entry, expected[path]);
    matchesUntouched &&= isDeepStrictEqual(entry, untouched?.[path]);

    if (!matchesExpected && !matchesUntouched) {
      throw new Error('Recorded ignore files changed. Keep checker output for manual recovery.');
    }
  }

  // Only per-directory rules and the frozen external rules apply. Current external excludes are never read.
  const excludeDirectory = excludes ? await mkdtemp(join(tmpdir(), 'tau-excludes-')) : null;
  let listed: Buffer;

  try {
    const excludeFrom: string[] = [];

    if (excludeDirectory) {
      await writeFile(join(excludeDirectory, 'excludes'), excludes, { mode: 0o600 });
      excludeFrom.push(`--exclude-from=${join(excludeDirectory, 'excludes')}`);
    }

    listed = await gitBytes(root, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-per-directory=.gitignore',
      ...excludeFrom,
      '-z',
    ]);
  } finally {
    if (excludeDirectory) {
      await rm(excludeDirectory, { recursive: true, force: true });
    }
  }

  const paths = new TextDecoder('utf-8', { fatal: true })
    .decode(listed)
    .split('\0')
    .filter(Boolean);
  const known = new Set(knownPaths);

  return paths.filter(
    (path) => !known.has(path) && !isIgnoreFile(path) && !isExcluded(path, originalIgnored),
  );
};

export const recoveryWorkingState = async (
  root: string,
  knownPaths: string[],
  ignored: string[],
): Promise<Working> => {
  const paths = new Set(knownPaths);
  const visit = async (directory: string) => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;

      if (entry.name === '.git' || isExcluded(path, ignored)) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(path);
      } else {
        paths.add(path);
      }
    }
  };
  await visit('');
  const entries: Working = {};
  let bytes = 0;

  for (const path of [...paths].toSorted()) {
    const snapshot = await readWorkingEntry(root, path, 100 * 1024 * 1024 - bytes);
    bytes += snapshot.bytes;
    entries[path] = snapshot.entry;
  }

  return entries;
};

interface Manifest {
  ignored: string[];
  excludes?: string;
  root: string;
  head: string | null;
  headFile: string;
  identity: Awaited<ReturnType<typeof indexIdentity>>;
  original: Working;
  hidden: Working;
  indexDigest: string | null;
  recoveryRef: string;
  tree: string;
}

const verifyArchive = async (pi: Git, root: string, gitDirectory: string, archive: string) => {
  await requireDirectory(archive);
  const bytes = await read(join(archive, 'manifest.json'));

  if (digest(bytes) !== (await read(join(archive, 'manifest.sha256'))).toString()) {
    throw new Error('Corrupt recovery manifest');
  }

  const value: unknown = JSON.parse(bytes.toString());
  const schema = Type.Object(
    {
      ignored: Type.Array(Type.String()),
      excludes: Type.Optional(Type.String()),
      root: Type.String(),
      head: Type.Union([Type.String(), Type.Null()]),
      headFile: Type.String(),
      identity: Type.Object({ entries: Type.String(), flags: Type.Array(Type.String()) }),
      original: workingSchema,
      hidden: workingSchema,
      indexDigest: Type.Union([Type.String(), Type.Null()]),
      recoveryRef: Type.String(),
      tree: Type.String(),
    },
    { additionalProperties: false },
  );

  if (!Value.Check(schema, value)) {
    throw new Error('Invalid recovery manifest');
  }

  const manifest: Manifest = value;
  validateWorking(manifest.original);
  validateWorking(manifest.hidden);

  if (
    manifest.root !== root ||
    !isDeepStrictEqual(
      Object.keys(manifest.original).toSorted(),
      Object.keys(manifest.hidden).toSorted(),
    ) ||
    manifest.recoveryRef !== `refs/tau/recovery/${basename(archive)}`
  ) {
    throw new Error('Invalid recovery identity');
  }

  const original = parseWorking(await read(join(archive, 'working.json')));
  const index = (await optionalStatus(join(archive, 'original-index')))
    ? await read(join(archive, 'original-index'))
    : null;

  if (
    !isDeepStrictEqual(original, manifest.original) ||
    (index ? digest(index) : null) !== manifest.indexDigest ||
    (await reviewGit(pi, root, ['rev-parse', manifest.recoveryRef])).trim() !== manifest.tree
  ) {
    throw new Error('Corrupt recovery backup or object ref');
  }

  await requireDirectory(gitDirectory);

  return { manifest, checksum: digest(bytes) };
};
const verifyGlobal = async (root: string, gitDirectory: string, manifest: Manifest) => {
  const index = await readIndex(gitDirectory);

  if (
    (await head(root)) !== manifest.head ||
    (await read(join(gitDirectory, 'HEAD'))).toString('base64') !== manifest.headFile
  ) {
    throw new Error('HEAD changed; recovery refused');
  }

  if (
    (index ? digest(index) : null) !== manifest.indexDigest ||
    !isDeepStrictEqual(await indexIdentity(root), manifest.identity)
  ) {
    throw new Error('Index changed; concurrent staging left untouched');
  }
};

export const saveRecovery = async (
  pi: Git,
  root: string,
  expectedHidden: Working,
  candidateTree?: string,
) => {
  const gitDirectory = (await reviewGit(pi, root, ['rev-parse', '--absolute-git-dir'])).trimEnd();
  const { directory, pending } = recoveryPaths(gitDirectory);
  await assertNoPendingRecovery(gitDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await requireDirectory(directory);

  try {
    // Exclusive reservation comes first. An interrupted save blocks, but never changes working files or the shared index.
    await mkdir(pending, { mode: 0o700 });
    await mkdir(join(pending, 'owner.lock'), { mode: 0o700 });
    await sync(pending);
    await sync(directory);
    await sync(gitDirectory);

    if (process.env.GIT_OBJECT_DIRECTORY || process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES) {
      throw new Error('External Git object storage is unsupported');
    }

    const ignored = await ignoredPaths(root);
    const originalHead = await head(root);
    const headFile = (await read(join(gitDirectory, 'HEAD'))).toString('base64');
    const ownership = await snapshotPreparation(pi, root, []);
    const archive = ownership.directory;
    await save(join(pending, 'archive'), basename(archive));
    await sync(pending);

    const original = parseWorking(await read(join(archive, 'working.json')));
    await supportedWorking(root, original);
    validateWorking(expectedHidden);

    if (Object.keys(expectedHidden).some((path) => !Object.hasOwn(original, path))) {
      throw new Error('New paths and directory transitions are unsupported');
    }

    const hidden = { ...original, ...expectedHidden };
    const originalIndex = await readIndex(gitDirectory);
    const savedIndex = (await optionalStatus(join(archive, 'original-index')))
      ? await read(join(archive, 'original-index'))
      : null;

    if (!isDeepStrictEqual(originalIndex, savedIndex)) {
      throw new Error('Index changed during backup');
    }

    const recoveryRef = (await read(join(archive, 'recovery-ref'))).toString().trim();
    const tree = (await reviewGit(pi, root, ['rev-parse', recoveryRef])).trim();

    if (candidateTree && (tree !== candidateTree || !isDeepStrictEqual(hidden, expectedHidden))) {
      throw new Error(
        'Staging or working coverage changed since projection. Inspect concurrent work before retrying.',
      );
    }

    const manifest: Manifest = {
      ignored,
      excludes: await externalExcludes(root),
      root,
      head: originalHead,
      headFile,
      identity: await indexIdentity(root),
      original,
      hidden,
      indexDigest: savedIndex ? digest(savedIndex) : null,
      recoveryRef,
      tree,
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    await save(join(archive, 'manifest.json'), bytes);
    await save(join(archive, 'manifest.sha256'), digest(bytes));
    await save(
      join(archive, 'check-recovery.txt'),
      'Stop checkers and other writers before recovery. A pending owner.lock can belong to a live or interrupted operation; never remove it while a writer may survive.\n' +
        'working.json preserves original bytes, permissions, symlink targets and absence. manifest.json records the expected staged working state and original ignore exclusions.\n' +
        'hidden-displaced holds original inodes moved during hiding. displaced holds inodes moved during restoration. Numeric names index the path order of manifest.original, kept as displaced-paths.json after pruning. Keep both directories: open writers may still append to these files.\n' +
        'Compare backups and current files in a separate directory. Partial hiding or restoration requires manual inspection, not stash apply or forced checkout.\n' +
        'original-index and the recovery ref preserve staging. Never copy that index over concurrent staging or move HEAD to clear a recovery error.\n' +
        'Keep pending until writers have stopped and working files, staging and HEAD have been inspected and recovered. After verified restoration Tau removes the snapshots and the ref and keeps displaced and hidden-displaced; delete those only once no writer can still hold them open.\n',
    );
    await syncTree(archive);

    const commonDirectory = (
      await reviewGit(pi, root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trimEnd();
    await saveIndexObjects(root, commonDirectory, tree);
    let refPath = join(commonDirectory, recoveryRef);
    await sync(refPath);

    while (refPath !== commonDirectory) {
      refPath = dirname(refPath);
      await sync(refPath);
    }

    await sync(directory);
    await verifyArchive(pi, root, gitDirectory, archive);
    await verifyGlobal(root, gitDirectory, manifest);

    if (
      !isDeepStrictEqual(original, await recoveryWorkingState(root, Object.keys(original), ignored))
    ) {
      throw new Error('Working state changed during backup');
    }

    await save(join(pending, 'ready'), digest(bytes));
    await sync(pending);
    await sync(directory);

    if (
      (await read(join(pending, 'ready'))).toString() !== digest(bytes) ||
      (await read(join(pending, 'archive'))).toString() !== basename(archive)
    ) {
      throw new Error('Pending marker readback failed');
    }

    await verifyArchive(pi, root, gitDirectory, archive);
    await verifyGlobal(root, gitDirectory, manifest);
    await supportedWorking(root, original);

    if (
      !isDeepStrictEqual(original, await recoveryWorkingState(root, Object.keys(original), ignored))
    ) {
      throw new Error('Working state changed before authorization');
    }

    await rm(join(pending, 'owner.lock'), { recursive: true });
    await sync(pending);

    return archive;
  } catch (error) {
    throw new Error(`Recovery not authorized. Retained data at ${directory}. ${String(error)}`, {
      cause: error,
    });
  }
};

const replaceWorking = async (
  root: string,
  gitDirectory: string,
  archive: string,
  manifest: Manifest,
  hiding = false,
) => {
  const displaced = join(archive, hiding ? 'hidden-displaced' : 'displaced');
  const replacements = join(archive, hiding ? 'hidden-replacements' : 'replacements');
  await mkdir(displaced, { mode: 0o700 });
  await mkdir(replacements, { mode: 0o700 });
  await sync(archive);

  const destination = hiding ? manifest.hidden : manifest.original;
  const source = hiding ? manifest.original : manifest.hidden;

  for (const [position, [path, original]] of Object.entries(destination).entries()) {
    const hidden = source[path];

    if (isDeepStrictEqual(original, hidden)) {
      continue;
    }

    const replacement = join(replacements, String(position));

    if (original?.kind === 'file') {
      await save(replacement, Buffer.from(original.content, 'base64'));
      await chmod(replacement, original.mode);
      await sync(replacement);
    } else if (original) {
      await symlink(Buffer.from(original.content, 'base64'), replacement);
    }

    await sync(replacements);
    await verifyGlobal(root, gitDirectory, manifest);
    await parents(root, path);
    const before = await readWorkingEntry(root, path);

    if (!isDeepStrictEqual(before.entry, hidden)) {
      throw new Error(`Working state changed before restoring ${JSON.stringify(path)}`);
    }

    const absolute = join(root, path);

    if (hidden) {
      const saved = join(displaced, String(position));
      await rename(absolute, saved);
      await sync(displaced);
      await sync(dirname(absolute));
      await parents(root, path);
      const status = await lstat(saved);

      if ((!status.isFile() && !status.isSymbolicLink()) || status.nlink !== 1) {
        throw new Error(`Unsupported raced path retained at ${saved}`);
      }

      const content = status.isSymbolicLink()
        ? await readlink(saved, { encoding: 'buffer' })
        : await read(saved, true);
      const moved = {
        kind: status.isSymbolicLink() ? 'symlink' : 'file',
        mode: status.mode & 0o7777,
        content: content.toString('base64'),
      };

      if (!isDeepStrictEqual(moved, hidden)) {
        throw new Error(`Raced bytes retained at ${saved}`);
      }
    }

    await parents(root, path);
    await verifyGlobal(root, gitDirectory, manifest);

    if (original) {
      // link is atomic and refuses collisions. Remove the temporary link before verification so nlink returns to one.
      await link(replacement, absolute);
      await rm(replacement);
      await sync(replacements);
    } else if (await optionalStatus(absolute)) {
      throw new Error(`Untracked collision at ${JSON.stringify(path)}`);
    }

    await sync(dirname(absolute));
    await parents(root, path);
  }
};

// Verified restoration leaves nothing for the snapshots to protect. Displaced inodes stay: open writers may still append to them.
const retainedNames = [
  'displaced',
  'hidden-displaced',
  'displaced-paths.json',
  'check-recovery.txt',
];
const pruneArchive = async (pi: Git, root: string, archive: string, manifest: Manifest) => {
  await save(join(archive, 'displaced-paths.json'), JSON.stringify(Object.keys(manifest.original)));
  await reviewGit(pi, root, ['update-ref', '-d', manifest.recoveryRef, manifest.tree]);

  for (const name of await readdir(archive)) {
    if (!retainedNames.includes(name)) {
      await rm(join(archive, name), { recursive: true, force: true });
    }
  }

  for (const name of ['displaced', 'hidden-displaced']) {
    if ((await readdir(join(archive, name)).catch(() => ['missing'])).length === 0) {
      await rm(join(archive, name), { recursive: true });
    }
  }

  if ((await readdir(archive)).every((name) => !name.endsWith('displaced'))) {
    await rm(archive, { recursive: true });
  }
};

export const recoverPending = async (pi: Git, root: string) => {
  const gitDirectory = (await reviewGit(pi, root, ['rev-parse', '--absolute-git-dir'])).trimEnd();
  const { directory, pending } = recoveryPaths(gitDirectory);

  try {
    await requireDirectory(directory);
    await requireDirectory(pending);
    // A dead recovery owner requires manual inspection. Never steal its lock and guess what it displaced.
    await mkdir(join(pending, 'owner.lock'), { mode: 0o700 });
    await sync(pending);
    const name = (await read(join(pending, 'archive'))).toString();

    if (!/^prepare-[A-Za-z0-9]+$/.test(name)) {
      throw new Error('Invalid recovery archive path');
    }

    const archive = join(directory, name);
    const { manifest, checksum } = await verifyArchive(pi, root, gitDirectory, archive);

    if ((await read(join(pending, 'ready'))).toString() !== checksum) {
      throw new Error('Incomplete pending recovery');
    }

    await verifyGlobal(root, gitDirectory, manifest);
    await supportedWorking(root, manifest.original);
    const knownPaths = Object.keys(manifest.original);
    const ignored = [
      ...manifest.ignored,
      ...(await newIgnoredArtifacts(
        root,
        manifest.hidden,
        manifest.original,
        manifest.ignored,
        manifest.excludes,
      )),
    ];
    const current = await recoveryWorkingState(root, knownPaths, ignored);
    const untouched = isDeepStrictEqual(current, manifest.original);

    if (!untouched && !isDeepStrictEqual(current, manifest.hidden)) {
      throw new Error('Unexpected or partial working state; manual recovery required');
    }

    if (!untouched) {
      await replaceWorking(root, gitDirectory, archive, manifest);
    }

    await verifyGlobal(root, gitDirectory, manifest);
    await supportedWorking(root, manifest.original);

    if (
      !isDeepStrictEqual(await recoveryWorkingState(root, knownPaths, ignored), manifest.original)
    ) {
      throw new Error('Restoration verification failed');
    }

    await rm(pending, { recursive: true });
    await sync(directory);
    // Leftovers are harmless; a locked ref or busy file must not fail a verified restoration.
    await pruneArchive(pi, root, archive, manifest).catch(() => undefined);
  } catch (error) {
    throw new Error(`Recovery stopped. Keep data at ${directory}. ${String(error)}`, {
      cause: error,
    });
  }
};

export const hidePending = async (pi: Git, root: string) => {
  const gitDirectory = (await reviewGit(pi, root, ['rev-parse', '--absolute-git-dir'])).trimEnd();
  const { directory, pending } = recoveryPaths(gitDirectory);

  try {
    await requireDirectory(directory);
    await requireDirectory(pending);
    await mkdir(join(pending, 'owner.lock'), { mode: 0o700 });
    await sync(pending);
    const name = (await read(join(pending, 'archive'))).toString();

    if (!/^prepare-[A-Za-z0-9]+$/.test(name)) {
      throw new Error('Invalid recovery archive path');
    }

    const archive = join(directory, name);
    const { manifest, checksum } = await verifyArchive(pi, root, gitDirectory, archive);

    if ((await read(join(pending, 'ready'))).toString() !== checksum) {
      throw new Error('Incomplete pending recovery');
    }

    await verifyGlobal(root, gitDirectory, manifest);
    await supportedWorking(root, manifest.original);

    if (
      !isDeepStrictEqual(
        await recoveryWorkingState(root, Object.keys(manifest.original), manifest.ignored),
        manifest.original,
      )
    ) {
      throw new Error('Working state changed before hiding');
    }

    const assertHidden = async () => {
      await verifyGlobal(root, gitDirectory, manifest);
      await supportedWorking(root, manifest.hidden);
      const knownPaths = Object.keys(manifest.original);
      const ignored = [
        ...manifest.ignored,
        ...(await newIgnoredArtifacts(
          root,
          manifest.hidden,
          undefined,
          manifest.ignored,
          manifest.excludes,
        )),
      ];

      if (
        !isDeepStrictEqual(await recoveryWorkingState(root, knownPaths, ignored), manifest.hidden)
      ) {
        throw new Error(
          'Checker changed working files. Keep original and checker output for manual recovery.',
        );
      }
    };
    await replaceWorking(root, gitDirectory, archive, manifest, true);
    await assertHidden();

    return {
      assertHidden,
      async restore() {
        // Keep ownership throughout command execution. Only this window can release it for recovery.
        await rm(join(pending, 'owner.lock'), { recursive: true });
        await recoverPending(pi, root);
      },
    };
  } catch (error) {
    throw new Error(
      `Hiding stopped. Keep recovery data at ${directory}. Read the archive's check-recovery.txt. ${String(error)}`,
      { cause: error },
    );
  }
};
