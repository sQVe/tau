import { join } from 'node:path';

import { readGit, runGit } from '../../git.js';
import { fixedPrefixes, readSavedRecapture } from '../../reviewCapture/reviewCapture.js';
import type { SavedRecapture } from '../../reviewCapture/reviewCapture.js';
import { existingEntry } from '../../tauDirectory.js';
import { compareDiffs, decideReuse } from './reuseDecisions.js';
import type { DiffComparison, Reuse } from './reuseDecisions.js';

export interface ReuseRequest {
  directory: string | undefined;
  mergeBase: string | undefined;
}

export interface ReuseResult extends Reuse {
  recordedBase: string | null;
  paths: DiffComparison;
  reports: string[];
}

const reportFileNames = ['reviewer.md', 'finder.md', 'checker.md'];

const resolveCommit = (root: string, revision: string): Promise<string> =>
  readGit(root, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);

// Git exits with 1 when the first commit is not an ancestor of the second.
const isAncestor = async (root: string, ancestor: string, descendant: string) => {
  const commandArguments = ['merge-base', '--is-ancestor', ancestor, descendant];

  const result = await runGit(root, commandArguments);

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.exitCode === 0;
};

// --no-textconv and the fixed prefixes match the diff that code_review captures.
const readBranchDiff = async (root: string, mergeBase: string) => {
  const commandArguments = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    ...fixedPrefixes,
    '--end-of-options',
    mergeBase,
    'HEAD',
  ];

  const result = await runGit(root, commandArguments);

  if (result.exitCode !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.stdout;
};

const isRegularFile = async (path: string) => {
  const entry = await existingEntry(path);

  return entry?.isFile() === true;
};

const listReports = async (directory: string) => {
  const exists = await Promise.all(
    reportFileNames.map((name) => isRegularFile(join(directory, name))),
  );

  return reportFileNames.filter((_, index) => exists[index] === true);
};

export const decideSavedReuse = async (
  root: string,
  saved: SavedRecapture,
  revision: string,
): Promise<ReuseResult> => {
  const mergeBase = await resolveCommit(root, revision);
  const recordedBase = saved.recordedBase;
  const baseIsAncestor = recordedBase !== null && (await isAncestor(root, recordedBase, mergeBase));
  const comparison = compareDiffs(saved.recheck, await readBranchDiff(root, mergeBase));

  const decision = decideReuse({
    recordedHash: saved.recordedHash,
    recheckHash: saved.recheckHash,
    recordedBase,
    mergeBase,
    baseIsAncestor,
    comparison,
  });

  return {
    ...decision,
    recordedBase,
    paths: comparison,
    reports: await listReports(saved.directory),
  };
};

export const readReuse = async (root: string, request: ReuseRequest): Promise<ReuseResult> => {
  if (request.directory === undefined) {
    throw new Error('reuse needs directory, a .tau/workers/review-* directory.');
  }

  if (request.mergeBase === undefined) {
    throw new Error('reuse needs mergeBase.');
  }

  const saved = await readSavedRecapture(root, request.directory);

  return decideSavedReuse(root, saved, request.mergeBase);
};
