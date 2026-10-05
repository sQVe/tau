import { appendFile, lstat, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from './errors.js';
import { readGitOutput } from './gitOutput.js';

const ignoreEverything = '*';

const isNameSegment = (segment: string) => !['', '.', '..'].includes(segment);

// Windows also reads `\` as a separator, so a segment with one could step out of `.tau`.
const hasBackslash = (text: string) => text.includes('\\');

const parseSegments = (path: string) => {
  if (hasBackslash(path)) {
    throw new Error(`A Tau directory path must not contain a backslash: ${path}`);
  }

  const segments = path.split('/');
  const invalid = !segments.every(isNameSegment);

  if (invalid) {
    throw new Error(`A Tau directory path must name directories below .tau: ${path}`);
  }

  return segments;
};

// Lists `.tau`, each directory down to the target, and `.tau/.gitignore`, parents first.
const writtenPaths = (segments: readonly string[]) => [
  ...Array.from({ length: segments.length + 1 }, (_, index) =>
    ['.tau', ...segments.slice(0, index)].join('/'),
  ),
  '.tau/.gitignore',
];

const isSymlink = async (path: string) => {
  try {
    const stats = await lstat(path);

    return stats.isSymbolicLink();
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }

    throw error;
  }
};

const rejectSymlinks = async (root: string, relativePaths: readonly string[]) => {
  const symlinks = await Promise.all(relativePaths.map((path) => isSymlink(join(root, path))));
  const firstSymlink = relativePaths.find((_, index) => symlinks[index] === true);

  if (firstSymlink !== undefined) {
    throw new Error(`Refusing to write through a symlink: ${firstSymlink}`);
  }
};

// A hard link shares its file with another path, maybe outside the checkout, so an append to
// .tau/.gitignore would change that file too.
const rejectHardLinkedIgnoreFile = async (root: string) => {
  const path = '.tau/.gitignore';

  try {
    const stats = await lstat(join(root, path));

    if (stats.nlink > 1) {
      throw new Error(`Refusing to write through a file with another hard link: ${path}`);
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
};

const readIgnoreFile = async (path: string) => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return '';
    }

    throw error;
  }
};

const isRule = (line: string) => line.trim() !== '' && !line.startsWith('#');

// Git applies the last rule that matches, so `*` must come after any `!` exception.
const endsWithIgnoreEverything = (content: string) =>
  content.split('\n').findLast(isRule) === ignoreEverything;

const ignoreTauDirectory = async (root: string) => {
  const ignoreFile = join(root, '.tau/.gitignore');
  const content = await readIgnoreFile(ignoreFile);

  if (endsWithIgnoreEverything(content)) {
    return;
  }

  await appendFile(ignoreFile, `\n${ignoreEverything}\n`);
};

const hasExceptionAfterIgnoreEverything = (content: string) => {
  const rules = content.split('\n').filter(isRule);
  const laterRules = rules.slice(rules.lastIndexOf(ignoreEverything) + 1);

  return laterRules.some((rule) => rule.startsWith('!'));
};

// The probe below checks one file name only, so an exception for another file would pass it.
const rejectLaterExceptions = async (root: string) => {
  const content = await readIgnoreFile(join(root, '.tau/.gitignore'));

  if (hasExceptionAfterIgnoreEverything(content)) {
    throw new Error(`An exception follows the last ${ignoreEverything} rule in .tau/.gitignore`);
  }
};

// Git does not ignore a file it tracks, so a write to a tracked path would show as a change.
const rejectTracked = async (root: string, relativePath: string) => {
  const tracked = await readGitOutput(root, ['ls-files', '--', relativePath]);

  if (tracked === undefined) {
    throw new Error(`Git could not list the tracked files in ${relativePath}`);
  }

  if (tracked.trim() !== '') {
    throw new Error(`Git tracks files in ${relativePath}`);
  }
};

// Asks Git whether a file in the target is ignored, and whether it tracks any file there already.
const rejectUnignored = async (root: string, relativeDirectory: string) => {
  const probe = `${relativeDirectory}/file`;
  const output = await readGitOutput(root, ['check-ignore', '--', probe]);

  if (output === undefined || output.trim() === '') {
    throw new Error(`Git does not ignore files in ${relativeDirectory}`);
  }

  await rejectTracked(root, relativeDirectory);
};

// Refuses `<root>/.tau/<path>` when a path a write would go through is a symlink, or
// `.tau/.gitignore` has another hard link, since either could send writes outside the repository,
// or when Git would not ignore files in it. Changes nothing, so a read can run it.
export const checkTauDirectory = async (root: string, path: string): Promise<void> => {
  const segments = parseSegments(path);

  await rejectSymlinks(root, writtenPaths(segments));
  await rejectHardLinkedIgnoreFile(root);
  await rejectLaterExceptions(root);
  await rejectUnignored(root, ['.tau', ...segments].join('/'));
};

// Creates `<root>/.tau/<path>` and makes Git ignore everything in `.tau/`. Refuses before it
// creates anything when a path it would write through is a symlink, when `.tau/.gitignore` has
// another hard link, or when Git tracks
// `.tau/.gitignore` or a file in the target. Refuses before it creates the target when Git would
// not ignore it. A path swapped between the check and the write can still escape.
export const ensureTauDirectory = async (root: string, path: string): Promise<string> => {
  const segments = parseSegments(path);

  await rejectSymlinks(root, writtenPaths(segments));
  await rejectHardLinkedIgnoreFile(root);
  await rejectTracked(root, '.tau/.gitignore');
  await rejectTracked(root, ['.tau', ...segments].join('/'));

  await mkdir(join(root, '.tau'), { recursive: true });
  await ignoreTauDirectory(root);
  await checkTauDirectory(root, path);

  const directory = join(root, '.tau', ...segments);

  await mkdir(directory, { recursive: true });

  return directory;
};

// Creates a new, uniquely named directory `<root>/.tau/<parentPath>/<prefix>XXXXXX`.
export const createFreshTauDirectory = async (
  root: string,
  parentPath: string,
  prefix: string,
): Promise<string> => {
  if (prefix.includes('/')) {
    throw new Error(`A Tau directory prefix must not contain a slash: ${prefix}`);
  }

  if (hasBackslash(prefix)) {
    throw new Error(`A Tau directory prefix must not contain a backslash: ${prefix}`);
  }

  if (!isNameSegment(prefix)) {
    throw new Error(`A Tau directory prefix must be a name, not "${prefix}"`);
  }

  const parent = await ensureTauDirectory(root, parentPath);

  return mkdtemp(join(parent, prefix));
};
