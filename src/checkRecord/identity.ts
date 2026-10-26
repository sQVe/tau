import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { isMissingFile } from '../errors.js';
import { readGit, runGit } from '../git.js';
import { readOptionalText } from '../record.js';
import type { CheckIdentity } from './reuseDecision.js';

export interface CheckState {
  tree: string | null;
}

const copyIndex = async (indexPath: string, temporaryIndex: string): Promise<void> => {
  try {
    await copyFile(indexPath, temporaryIndex);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
};

const resolveCommit = async (root: string, reference: string): Promise<string | undefined> => {
  const commandArguments = ['rev-parse', '--verify', '--quiet', `${reference}^{commit}`];
  const result = await runGit(root, commandArguments);

  if (result.exitCode === null) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : undefined;
};

// Resolves base, a ref or commit, to a commit. Without base, the origin remote's default branch, or
// null when the checkout has none.
export const readBase = async (root: string, base: string | undefined): Promise<string | null> => {
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

// A submodule with modified content or untracked files keeps its commit in the tree, so two
// different edits would give the same tree ID.
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

const isAttributeRule = (line: string): boolean => {
  const text = line.trim();

  return text !== '' && !text.startsWith('#');
};

// Git still reads $GIT_DIR/info/attributes when content conversion is off, so a rule there could
// change the bytes it stages. Comment and blank lines are not rules.
const hasInfoAttributeRules = async (root: string): Promise<boolean> => {
  const path = resolve(root, await readGit(root, ['rev-parse', '--git-path', 'info/attributes']));
  const text = (await readOptionalText(path)) ?? '';

  return text.split('\n').some(isAttributeRule);
};

// Stages with no attributes, no filters, and no line-ending conversion, so the tree holds the raw
// bytes of each file. The empty tree has no attributes, and /dev/null is an empty attributes file.
const rawContentArguments = (emptyTree: string): string[] => [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.attributesFile=/dev/null',
  `--attr-source=${emptyTree}`,
];

// Writes every file Git does not ignore into a copy of the index, so the tree ID changes with each
// tracked or untracked file's path, raw content, and mode. The real index stays as it is.
const writeWorkingTree = async (root: string): Promise<string> => {
  const indexPath = resolve(root, await readGit(root, ['rev-parse', '--git-path', 'index']));
  const directory = await mkdtemp(join(tmpdir(), 'tau-check-index-'));
  const temporaryIndex = join(directory, 'index');

  try {
    await copyIndex(indexPath, temporaryIndex);

    const emptyTree = await readGit(root, ['hash-object', '-t', 'tree', '/dev/null']);
    const environment = { GIT_INDEX_FILE: temporaryIndex, GIT_ATTR_NOSYSTEM: '1' };

    await readGit(root, [...rawContentArguments(emptyTree), 'add', '--all'], { environment });

    return await readGit(root, ['write-tree'], { environment });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

// Reads the tree ID of the working state, or null when the tree ID cannot show every change, so the
// state is never reusable: a submodule has changes, or info/attributes sets rules.
export const readCheckState = async (root: string): Promise<CheckState> => {
  const cannotSeeChanges = (await hasDirtySubmodule(root)) || (await hasInfoAttributeRules(root));

  if (cannotSeeChanges) {
    return { tree: null };
  }

  return { tree: await writeWorkingTree(root) };
};

export const readCheckIdentity = async (root: string, argv: string[]): Promise<CheckIdentity> => ({
  ...(await readCheckState(root)),
  argv,
});
