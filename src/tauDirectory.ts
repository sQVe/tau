import { appendFile, lstat, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from './errors.js';
import { readGitOutput } from './gitOutput.js';

const ignoreEverything = '*';

const isNameSegment = (segment: string) => !['', '.', '..'].includes(segment);

const parseSegments = (path: string) => {
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

const ignoreTauDirectory = async (root: string) => {
  const ignoreFile = join(root, '.tau/.gitignore');
  const content = await readIgnoreFile(ignoreFile);

  if (content.split('\n').includes(ignoreEverything)) {
    return;
  }

  await appendFile(ignoreFile, `\n${ignoreEverything}\n`);
};

// A later `!` rule can undo the `*` rule, so ask Git whether a file in the target is ignored.
const rejectUnignored = async (root: string, relativeDirectory: string) => {
  const probe = `${relativeDirectory}/file`;
  const output = await readGitOutput(root, ['check-ignore', '--', probe]);

  if (output === undefined || output.trim() === '') {
    throw new Error(`Git does not ignore files in ${relativeDirectory}`);
  }
};

// Creates `<root>/.tau/<path>` and makes Git ignore everything in `.tau/`. Refuses before it
// creates anything when a path it would write through is a symlink, since the link could send
// writes outside the repository. Refuses before it creates the target when Git would not ignore it. A path swapped between the check and the write can still escape.
export const ensureTauDirectory = async (root: string, path: string): Promise<string> => {
  const segments = parseSegments(path);

  await rejectSymlinks(root, writtenPaths(segments));

  await mkdir(join(root, '.tau'), { recursive: true });
  await ignoreTauDirectory(root);
  await rejectUnignored(root, ['.tau', ...segments].join('/'));

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

  if (!isNameSegment(prefix)) {
    throw new Error(`A Tau directory prefix must be a name, not "${prefix}"`);
  }

  const parent = await ensureTauDirectory(root, parentPath);

  return mkdtemp(join(parent, prefix));
};
