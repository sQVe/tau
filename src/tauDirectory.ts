import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { isMissingFile } from './errors.js';
import { findCheckoutRoot, runGit } from './git.js';

export type TauChild =
  | { kind: 'outside' }
  | { kind: 'nested' }
  | { kind: 'unnamed' }
  | { kind: 'child'; name: string };

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

export const isSymlink = async (path: string): Promise<boolean> => {
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

// A linked file could send a read or write outside the checkout, and a read of a FIFO waits for a
// writer forever. A directory always has several links.
export const rejectLinkedFile = async (path: string, verb: 'read' | 'write'): Promise<void> => {
  const stats = await lstat(path).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  });

  if (stats === undefined) {
    return;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to ${verb} through a symlink: ${path}`);
  }

  if (!stats.isFile() && !stats.isDirectory()) {
    throw new Error(`Refusing to ${verb} through a file that is not a regular file: ${path}`);
  }

  if (stats.isFile() && stats.nlink > 1) {
    throw new Error(`Refusing to ${verb} through a file with another hard link: ${path}`);
  }
};

export const rejectLinkedEntries = async (directory: string): Promise<void> => {
  const names = await readdir(directory);

  for (const name of names) {
    // oxlint-disable-next-line no-await-in-loop -- Checking in directory order names the first refusal.
    await rejectLinkedFile(join(directory, name), 'write');
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

// Resolves Git's output, or undefined when Git fails or runs past the timeout, since session start
// waits for it.
const readQuickly = async (
  cwd: string,
  commandArguments: string[],
): Promise<string | undefined> => {
  const result = await runGit(cwd, commandArguments, { timeoutMilliseconds: 5000 });

  return result.exitCode === 0 ? result.stdout.toString('utf8') : undefined;
};

// Git does not ignore a file it tracks, so a write to a tracked path would show as a change.
const rejectTracked = async (root: string, relativePath: string) => {
  const tracked = await readQuickly(root, ['ls-files', '--', relativePath]);

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
  const output = await readQuickly(root, ['check-ignore', '--', probe]);

  if (output === undefined || output.trim() === '') {
    throw new Error(`Git does not ignore files in ${relativeDirectory}`);
  }

  await rejectTracked(root, relativeDirectory);
};

const isBareRoot = async (root: string) => {
  const output = await readQuickly(root, ['rev-parse', '--is-bare-repository']);

  return output?.trim() === 'true';
};

const findBareRoot = async (cwd: string, toolName: string) => {
  const output = await readQuickly(cwd, ['rev-parse', '--absolute-git-dir']);
  const path = output?.trim();

  if (path === undefined || path === '') {
    throw new Error(`The ${toolName} tool could not resolve the bare Git directory from ${cwd}.`);
  }

  const gitDirectory = await realpath(path);
  const parent = dirname(gitDirectory);
  const gitFile = join(parent, '.git');

  try {
    const stats = await stat(gitFile);

    if (!stats.isFile()) {
      return gitDirectory;
    }

    const content = await readFile(gitFile, 'utf8');
    const target = /^gitdir: (.+)\r?\n?$/.exec(content)?.[1];

    if (target !== undefined) {
      const targetDirectory = await realpath(resolve(parent, target.trim()));

      if (targetDirectory === gitDirectory) {
        return parent;
      }
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  return gitDirectory;
};

// Resolves the root that holds `.tau` for cwd: the bare repository root in a bare repository,
// otherwise the checkout root. toolName names the caller in errors.
export const findTauRoot = async (cwd: string, toolName: string): Promise<string> => {
  const bare = await isBareRoot(cwd);

  return bare ? findBareRoot(cwd, toolName) : findCheckoutRoot(cwd, toolName);
};

// Refuses `<root>/.tau/<path>` when a path a write would go through is a symlink, or
// `.tau/.gitignore` has another hard link, since either could send writes outside the repository,
// or when Git would not ignore files in it. Changes nothing, so a read can run it.
export const checkTauDirectory = async (root: string, path: string): Promise<void> => {
  const segments = parseSegments(path);

  await rejectSymlinks(root, writtenPaths(segments));
  await rejectHardLinkedIgnoreFile(root);
  await rejectLaterExceptions(root);

  if (await isBareRoot(root)) {
    const content = await readIgnoreFile(join(root, '.tau/.gitignore'));

    if (!endsWithIgnoreEverything(content)) {
      throw new Error('The bare repository needs a final * rule in .tau/.gitignore');
    }

    return;
  }

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

  if (await isBareRoot(root)) {
    await rejectLaterExceptions(root);
  } else {
    await rejectTracked(root, '.tau/.gitignore');
    await rejectTracked(root, ['.tau', ...segments].join('/'));
  }

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

// On POSIX a backslash is a name character, so `a\b/../..` climbs one level natively while the
// cross-platform walk counts two names. Both checks must pass. A name such as `..run-x` stays in.
const climbsOutNatively = (path: string) => {
  const normalized = normalize(path);

  return normalized === '..' || normalized.startsWith(`..${sep}`);
};

const climbsOutOnAnyPlatform = (path: string) => {
  let depth = 0;

  for (const segment of path.split(/[/\\]/)) {
    if (segment === '..') {
      depth -= 1;
    } else if (segment !== '' && segment !== '.') {
      depth += 1;
    }

    if (depth < 0) {
      return true;
    }
  }

  return false;
};

export const climbsOut = (path: string): boolean => {
  if (isAbsolute(path) || path.startsWith('\\')) {
    return true;
  }

  return climbsOutNatively(path) || climbsOutOnAnyPlatform(path);
};

// Places directory against `<root>/.tau/<parentPath>`: a child is one segment directly in it that
// starts with prefix and has more after it.
export const locateTauChild = (
  root: string,
  parentPath: string,
  prefix: string,
  directory: string,
): TauChild => {
  const name = relative(join(root, '.tau', parentPath), resolve(root, directory));

  if (climbsOut(name)) {
    return { kind: 'outside' };
  }

  if (name.includes('/') || hasBackslash(name)) {
    return { kind: 'nested' };
  }

  if (!name.startsWith(prefix) || name.length <= prefix.length) {
    return { kind: 'unnamed' };
  }

  return { kind: 'child', name };
};

export const requireTauChild = (
  root: string,
  parentPath: string,
  prefix: string,
  directory: string,
  label: string,
): string => {
  const located = locateTauChild(root, parentPath, prefix, directory);

  if (located.kind === 'outside') {
    throw new Error(`${label} must be in .tau/${parentPath}, not ${directory}.`);
  }

  if (located.kind === 'nested') {
    throw new Error(`${label} must sit directly in .tau/${parentPath}, not ${directory}.`);
  }

  if (located.kind === 'unnamed' && prefix === '') {
    throw new Error(`${label} must name a directory in .tau/${parentPath}, not ${directory}.`);
  }

  if (located.kind === 'unnamed') {
    throw new Error(`${label} must be named ${prefix}* by prepare, not ${directory}.`);
  }

  return located.name;
};
