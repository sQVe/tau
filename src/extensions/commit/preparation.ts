import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { reviewGit } from './commentReview.js';

const executeFile = promisify(execFile);
const maximumBytes = 100 * 1024 * 1024;

export type WorkingEntry = { mode: number; kind: 'file' | 'symlink'; content: string } | null;

const missingFile = (error: unknown) => {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    return null;
  }

  throw error;
};

const optionalRead = (path: string) => readFile(path).catch(missingFile);

const sameIndex = (left: Buffer | null, right: Buffer | null) =>
  left === null ? right === null : right !== null && left.equals(right);

export const gitBytes = async (
  root: string,
  arguments_: string[],
  index?: string,
  input?: string,
) => {
  const execution = executeFile('git', arguments_, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: maximumBytes,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(index ? { GIT_INDEX_FILE: index } : {}) },
  });
  const sent =
    input === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const standardInput = execution.child.stdin;

          if (!standardInput) {
            reject(new Error('Git standard input is unavailable'));
            return;
          }

          standardInput.once('error', reject);
          standardInput.end(input, resolve);
        });
  const [result] = await Promise.all([execution, sent]);

  return result.stdout;
};

const pathsFrom = (buffer: Buffer) => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);

  return text.split('\0').filter(Boolean);
};

export const indexIdentity = async (root: string, index?: string) => {
  const entries = await gitBytes(root, ['ls-files', '--stage', '-v', '-z'], index);
  const debug = await gitBytes(root, ['ls-files', '--debug', '-z'], index);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(debug);
  const flags: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const separator = text.indexOf('\0', offset);
    const metadata =
      /^  ctime: [^\n]*\n  mtime: [^\n]*\n  dev: [^\n]*\n  uid: [^\n]*\n  size: [^\n]*\tflags: ([0-9a-f]+)\n/.exec(
        text.slice(separator + 1),
      );

    if (separator < offset || !metadata?.[1]) {
      throw new Error('Cannot read index flags safely. Use a standard Git index and retry.');
    }

    flags.push(metadata[1]);
    offset = separator + 1 + metadata[0].length;
  }

  return { entries: entries.toString('base64'), flags };
};

export const readWorkingEntry = async (
  root: string,
  path: string,
  remainingBytes = maximumBytes,
): Promise<{ entry: WorkingEntry; bytes: number }> => {
  const absolute = join(root, path);
  let parent = dirname(absolute);

  while (parent !== root) {
    const status = await lstat(parent).catch(missingFile);

    if (status && !status.isDirectory()) {
      throw new Error(
        `Unsupported parent of ${JSON.stringify(path)}. Replace directory symlinks before retrying.`,
      );
    }

    parent = dirname(parent);
  }

  const status = await lstat(absolute).catch(missingFile);

  if (!status) {
    return { entry: null, bytes: 0 };
  }

  if (!status.isFile() && !status.isSymbolicLink()) {
    throw new Error(
      `Unsupported working path ${JSON.stringify(path)}. Move nested repositories or special files outside the checkout before retrying.`,
    );
  }

  if (status.size > remainingBytes) {
    throw new Error(
      'Preparation recovery exceeds 100 MiB. Move large untracked files outside the checkout or ignore them before retrying.',
    );
  }

  const content = status.isSymbolicLink()
    ? await readlink(absolute, { encoding: 'buffer' })
    : await readFile(absolute);

  return {
    bytes: status.size,
    entry: {
      mode: status.mode & 0o7777,
      kind: status.isSymbolicLink() ? 'symlink' : 'file',
      content: content.toString('base64'),
    },
  };
};

export const workingState = async (root: string, originalPaths: string[] = []) => {
  const listed = await gitBytes(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  const paths = [...new Set([...pathsFrom(listed), ...originalPaths])].toSorted();
  const entries = new Map<string, WorkingEntry>();
  let bytes = 0;

  for (const path of paths) {
    const snapshot = await readWorkingEntry(root, path, maximumBytes - bytes);
    bytes += snapshot.bytes;
    entries.set(path, snapshot.entry);
  }

  return Object.fromEntries(entries);
};

// Recovery is outside the worktree and stash stack. Working files are never rolled back automatically.
export const snapshotPreparation = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  root: string,
  requestedPaths: string[],
) => {
  if (!isAbsolute(root) || process.platform === 'win32' || process.env.GIT_INDEX_FILE) {
    throw new Error(
      'Safe preparation requires a local POSIX checkout without GIT_INDEX_FILE. Use a normal checkout before retrying.',
    );
  }

  for (const path of requestedPaths) {
    const status = await lstat(join(root, path)).catch(missingFile);

    if (status?.isDirectory()) {
      throw new Error(`Request individual files, not a directory: ${JSON.stringify(path)}.`);
    }
  }

  // --git-path can resolve an index symlink, hiding the unsupported path we must reject.
  const gitDirectory = (await reviewGit(pi, root, ['rev-parse', '--absolute-git-dir'])).replace(
    /\n$/,
    '',
  );
  const indexPath = join(gitDirectory, 'index');
  const indexStatus = await lstat(indexPath).catch(missingFile);

  if (indexStatus && !indexStatus.isFile()) {
    throw new Error(
      'Preparation requires a regular index file. Replace the symlink or special index with a regular Git index before retrying.',
    );
  }

  const originalIndex = await optionalRead(indexPath);
  const originalIdentity = await indexIdentity(root);
  const entries = pathsFrom(await gitBytes(root, ['ls-files', '--stage', '-z']));
  const flags = pathsFrom(await gitBytes(root, ['ls-files', '-v', '-z']));
  const splitIndex = (await reviewGit(pi, root, ['rev-parse', '--shared-index-path'])).trim();

  if (
    originalIdentity.flags.some((flag) => flag !== '0') ||
    splitIndex ||
    flags.some((entry) => !entry.startsWith('H ')) ||
    entries.some((entry) => !/^(100644|100755|120000) [a-f0-9]+ 0\t/.test(entry))
  ) {
    throw new Error(
      'Unsupported index: use a checkout without submodules, resolve conflicts, disable split/sparse indexes, and clear intent-to-add, assume-unchanged or skip-worktree flags before retrying.',
    );
  }

  const staged = pathsFrom(
    await gitBytes(root, ['diff', '--cached', '--no-renames', '--name-only', '-z']),
  );
  const before = await workingState(root, staged);
  const unstaged = pathsFrom(await gitBytes(root, ['diff', '--no-renames', '--name-only', '-z']));
  const untracked = pathsFrom(
    await gitBytes(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  );
  const dirty = new Set([...unstaged, ...staged, ...untracked]);
  const knownPaths = new Set([...Object.keys(before), ...staged]);
  const recoveryRoot = join(dirname(indexPath), 'tau-recovery');

  await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });

  const directory = await mkdtemp(join(recoveryRoot, 'prepare-'));
  const privateIndex = join(directory, 'candidate-index');
  const notice = `Recovery saved at ${directory}. Read recovery.txt before restoring anything.`;
  const recoveryRef = `refs/tau/recovery/${directory.split('/').at(-1)}`;
  const isolated: Pick<ExtensionAPI, 'exec'> = {
    exec: (command, arguments_, options) =>
      pi.exec('env', [`GIT_INDEX_FILE=${privateIndex}`, command, ...arguments_], options),
  };
  let recoveryTree = '';

  try {
    await writeFile(join(directory, 'working.json'), JSON.stringify(before), { mode: 0o600 });
    await writeFile(
      join(directory, 'recovery.txt'),
      'Working files were not restored automatically. Stop writers and inspect current edits first.\nworking.json maps root-relative paths to null (absent), or kind, permission mode, and base64 content. Decode content into a separate directory for comparison. For symlinks the content is the link target.\noriginal-index is the exact prior index, if one existed. The ref named in recovery-ref keeps its Git objects reachable. Do not delete that ref until recovery is complete.\nNever copy the original index over concurrent staging without comparing it first. candidate-index is private preparation state, not an approved index.\n',
      { mode: 0o600 },
    );

    if (originalIndex) {
      await writeFile(join(directory, 'original-index'), originalIndex, { mode: 0o600 });
      await writeFile(privateIndex, originalIndex, { mode: 0o600 });
    }

    if (!originalIndex) {
      await reviewGit(isolated, root, ['read-tree', '--empty']);
    }

    recoveryTree = (await reviewGit(isolated, root, ['write-tree'])).trim();
    await reviewGit(pi, root, ['update-ref', recoveryRef, recoveryTree, '']);
    await writeFile(join(directory, 'recovery-ref'), `${recoveryRef}\n`, { mode: 0o600 });

    if (
      !sameIndex(originalIndex, await optionalRead(indexPath)) ||
      JSON.stringify(before) !== JSON.stringify(await workingState(root, Object.keys(before)))
    ) {
      throw new Error(
        'Working files or index changed while taking the snapshot. Stop other writers and retry.',
      );
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${notice}`, {
      cause: error,
    });
  }

  let published: Awaited<ReturnType<typeof indexIdentity>> | null = null;

  const replaceIndex = async (
    expected: Awaited<ReturnType<typeof indexIdentity>>,
    replacement: Buffer | null,
  ) => {
    const lock = await open(
      `${indexPath}.lock`,
      'wx',
      indexStatus ? indexStatus.mode & 0o777 : 0o600,
    );
    let ownsLockPath = true;

    try {
      const currentStatus = await lstat(indexPath).catch(missingFile);

      if (
        (currentStatus && !currentStatus.isFile()) ||
        JSON.stringify(expected) !== JSON.stringify(await indexIdentity(root))
      ) {
        throw new Error(
          `Index ownership conflict. Concurrent staging was left untouched.\n${notice}`,
        );
      }

      if (replacement) {
        await lock.writeFile(replacement);
        await lock.sync();
        await lock.close();
        await rename(`${indexPath}.lock`, indexPath);
        ownsLockPath = false;
      } else {
        await rm(indexPath, { force: true });
      }
    } finally {
      await lock.close();

      if (ownsLockPath) {
        await rm(`${indexPath}.lock`, { force: true });
      }
    }
  };

  const stage = async (requested: Set<string>) => {
    const paths: string[] = [];
    const indexed = new Set(
      pathsFrom(await gitBytes(root, ['ls-files', '--cached', '-z'], privateIndex)),
    );

    for (const path of requested) {
      const status = await lstat(join(root, path)).catch(missingFile);

      if (status || indexed.has(path)) {
        paths.push(path);
      } else if (!knownPaths.has(path)) {
        throw new Error(`Requested path does not exist: ${JSON.stringify(path)}`);
      }
    }

    if (paths.length) {
      await reviewGit(isolated, root, ['--literal-pathspecs', 'add', '-A', '--', ...paths]);
    }
  };

  return {
    directory,
    isolated,
    notice,
    stage,
    async validate(requested: Set<string>, otherGroups: Set<string>) {
      const after = await workingState(root, Object.keys(before));
      const stagedPaths = pathsFrom(
        await gitBytes(
          root,
          ['diff', '--cached', '--no-renames', '--name-only', '-z'],
          privateIndex,
        ),
      );
      const changed = new Set([
        ...Object.keys(after).filter(
          (path) => JSON.stringify(before[path]) !== JSON.stringify(after[path]),
        ),
        ...stagedPaths,
      ]);
      const unrequested = [...changed].filter((path) => !requested.has(path));

      const conflicts = unrequested.filter((path) => otherGroups.has(path) || dirty.has(path));

      if (conflicts.length) {
        throw new Error(
          `Preparation ownership conflict on unrequested paths: ${JSON.stringify(conflicts)}. Do not absorb these edits.`,
        );
      }

      const preparedIndex = await indexIdentity(root, privateIndex);
      const sameWorking = async () =>
        JSON.stringify(after) === JSON.stringify(await workingState(root, Object.keys(after)));

      return {
        added: unrequested.toSorted(),
        async accept() {
          const unchangedWorking = await sameWorking();
          const unchangedIndex =
            JSON.stringify(preparedIndex) ===
            JSON.stringify(await indexIdentity(root, privateIndex));

          if (!unchangedWorking || !unchangedIndex) {
            throw new Error(
              'Working files or private index changed during preparation assignment. Inspect the changes and retry.',
            );
          }

          // Preserve staged-only output. Restage only generated working changes, including tracked deletions.
          const workingChanges = unrequested.filter(
            (path) => JSON.stringify(before[path] ?? null) !== JSON.stringify(after[path] ?? null),
          );

          await stage(new Set(workingChanges));

          if (!(await sameWorking())) {
            throw new Error(
              'Working files changed during preparation assignment. Inspect the changes and retry.',
            );
          }
        },
      };
    },
    async publish() {
      await reviewGit(isolated, root, ['write-tree']);

      const candidate = await readFile(privateIndex);

      const candidateIdentity = await indexIdentity(root, privateIndex);

      await replaceIndex(originalIdentity, candidate);
      published = candidateIdentity;
    },
    async cleanup() {
      if (published) {
        await replaceIndex(published, originalIndex);
        published = null;
      }
    },
    async discard() {
      await reviewGit(pi, root, ['update-ref', '-d', recoveryRef, recoveryTree]);
      await rm(directory, { recursive: true, force: true });
    },
  };
};
