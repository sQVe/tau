import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from '../../errors.js';
import { runGit } from '../../gitOutput.js';
import type { CheckIdentity } from './reuseDecision.js';

const hashText = (text: Buffer | string): string => createHash('sha256').update(text).digest('hex');

const readGitText = async (
  root: string,
  commandArguments: string[],
): Promise<string | undefined> => {
  const result = await runGit(root, commandArguments);

  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : undefined;
};

const resolveCommit = (root: string, reference: string): Promise<string | undefined> =>
  readGitText(root, ['rev-parse', '--verify', '--quiet', `${reference}^{commit}`]);

const readBase = async (root: string, base: string | undefined): Promise<string | null> => {
  if (base === undefined) {
    return (await resolveCommit(root, 'origin/HEAD')) ?? null;
  }

  if (base.startsWith('-')) {
    throw new Error(`The base ${base} must be a ref or commit, not an option.`);
  }

  const commit = await resolveCommit(root, base);

  if (commit === undefined) {
    throw new Error(`The base ${base} does not name a commit in ${root}.`);
  }

  return commit;
};

const executableBits = 0o111;

const hashUntrackedFile = async (root: string, path: string): Promise<string> => {
  try {
    const stats = await lstat(join(root, path));

    if (stats.isSymbolicLink()) {
      return `link:${hashText(await readlink(join(root, path)))}`;
    }

    if (!stats.isFile()) {
      return 'not-a-file';
    }

    const executable = (stats.mode & executableBits) === 0 ? 'plain' : 'executable';

    return `file:${executable}:${hashText(await readFile(join(root, path)))}`;
  } catch (error) {
    if (isMissingFile(error)) {
      return 'missing';
    }

    throw error;
  }
};

// A submodule with modified content, new commits, or untracked files shows only as "dirty" in
// the diff, so two different edits would hash alike.
const hasDirtySubmodule = async (root: string): Promise<boolean> => {
  const status = await runGit(root, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none']);

  if (status.exitCode !== 0) {
    throw new Error(`git status failed in ${root}: ${status.stderr.trim()}`);
  }

  return status.stdout
    .toString('utf8')
    .split('\0')
    .some((entry) => /^[12] \S+ S(?!\.\.\.)[C.][M.][U.] /u.test(entry));
};

// Hashes the tracked changes against HEAD, staged or not, and the path and content of each
// untracked file that Git does not ignore.
const readFingerprint = async (root: string): Promise<string | null> => {
  if (await hasDirtySubmodule(root)) {
    return null;
  }

  const diff = await runGit(root, [
    'diff',
    '--binary',
    '--no-textconv',
    '--no-ext-diff',
    '--no-color',
    'HEAD',
  ]);

  if (diff.exitCode !== 0) {
    throw new Error(`git diff failed in ${root}: ${diff.stderr.trim()}`);
  }

  const listing = await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);

  if (listing.exitCode !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${listing.stderr.trim()}`);
  }

  const paths = listing.stdout
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '')
    .toSorted();

  const contentHashes = await Promise.all(paths.map((path) => hashUntrackedFile(root, path)));
  const hash = createHash('sha256');

  hash.update(`${hashText(diff.stdout)}\0`);

  paths.forEach((path, index) => {
    hash.update(`${path}\0${contentHashes[index]}\0`);
  });

  return hash.digest('hex');
};

// Reads what a full check result depends on. base is a ref or commit; without it, the origin
// remote's default branch, or null when the checkout has none.
export const readCheckIdentity = async (
  root: string,
  argv: string[],
  base: string | undefined,
): Promise<CheckIdentity> => {
  const head = await readGitText(root, ['rev-parse', 'HEAD']);

  if (head === undefined) {
    throw new Error(`The full_check tool needs a commit at HEAD in ${root}.`);
  }

  return {
    head,
    base: await readBase(root, base),
    argv,
    fingerprint: await readFingerprint(root),
  };
};
