import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../../errors.js';
import { describeSchemaProblem } from '../../schemaProblem.js';
import { createFreshTauDirectory, findTauRoot, locateTauChild } from '../../tauDirectory.js';

export interface Review {
  // The real `.tau` directory the paths are relative to.
  tauDirectory: string;
  // Holds the review record and the original content of each file.
  recordDirectory: string;
  // A directory outside Git that tuicr opens, with the files laid out by their `.tau` paths.
  stagingDirectory: string;
  paths: string[];
}

const recordParent = 'draft-review';
const recordPrefix = 'review-';
const manifestName = 'review.json';
const manifestVersion = 1;

const manifestSchema = Type.Object(
  {
    version: Type.Literal(manifestVersion),
    stagingDirectory: Type.String({ minLength: 1 }),
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false },
);

const isNewerVersion = (value: unknown) => {
  const version =
    typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined;

  return typeof version === 'number' && version > manifestVersion;
};

export const parseReviewManifest = (
  path: string,
  content: string,
): Static<typeof manifestSchema> => {
  let value: unknown;

  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Malformed review record ${path}: not JSON.`, { cause: error });
  }

  if (isNewerVersion(value)) {
    throw new Error(
      `Review record ${path} has a newer format than this Tau reads. Update Tau, then restart the session.`,
    );
  }

  if (!Value.Check(manifestSchema, value)) {
    throw new Error(
      `Malformed review record ${path}: ${describeSchemaProblem(manifestSchema, value)}.`,
    );
  }

  return value;
};

// On POSIX a backslash is a name character, so `a\b/../..` climbs one level natively while the
// cross-platform walk counts two names. Both checks must pass.
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

const climbsOut = (path: string) => {
  if (isAbsolute(path) || path.startsWith('\\')) {
    return true;
  }

  return climbsOutNatively(path) || climbsOutOnAnyPlatform(path);
};

const realFile = async (tauDirectory: string, requested: string, cwd: string): Promise<string> => {
  const absolute = resolve(cwd, requested);
  let real: string;

  try {
    real = await realpath(absolute);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`draft_review path does not exist: ${requested}`, { cause: error });
    }

    throw error;
  }

  if (climbsOut(relative(tauDirectory, real))) {
    throw new Error(`draft_review path is outside the repository's .tau directory: ${requested}`);
  }

  const stats = await stat(real);

  if (!stats.isFile()) {
    throw new Error(`draft_review path is not a file: ${requested}`);
  }

  return real;
};

const reviewablePaths = async (
  tauDirectory: string,
  requested: readonly string[],
  cwd: string,
): Promise<string[]> => {
  if (requested.length === 0) {
    throw new Error('draft_review action review needs at least one path.');
  }

  const files = await Promise.all(
    requested.map(async (path) => ({ path, real: await realFile(tauDirectory, path, cwd) })),
  );

  const paths = files.map(({ path, real }) => {
    const inTauDirectory = relative(tauDirectory, real);

    if (inTauDirectory.startsWith(`${recordParent}/`)) {
      throw new Error(`draft_review cannot review its own records: ${path}`);
    }

    return inTauDirectory;
  });

  return [...new Set(paths)];
};

const stagingPrefix = 'tau-draft-review-';

const copyInto = async (from: string, to: string) => {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
};

const populateReview = async (review: Review) => {
  const { tauDirectory, recordDirectory, stagingDirectory, paths } = review;

  // Staging copies the saved original, not the live file, so both start from one snapshot.
  const copies = await Promise.allSettled(
    paths.map(async (path) => {
      const original = join(recordDirectory, 'originals', path);

      await copyInto(join(tauDirectory, path), original);
      await copyInto(original, join(stagingDirectory, path));
    }),
  );

  const failed = copies.find((copy) => copy.status === 'rejected');

  if (failed) {
    throw failed.reason;
  }

  const manifest = { version: manifestVersion, stagingDirectory, paths };

  await writeFile(join(recordDirectory, manifestName), JSON.stringify(manifest, null, 2));
};

export const stageReview = async (cwd: string, requested: readonly string[]): Promise<Review> => {
  const root = await findTauRoot(cwd, 'draft_review');
  const tauDirectory = await realpath(join(root, '.tau'));
  const paths = await reviewablePaths(tauDirectory, requested, cwd);
  const recordDirectory = await createFreshTauDirectory(root, recordParent, recordPrefix);
  let stagingDirectory = '';

  try {
    stagingDirectory = await mkdtemp(join(tmpdir(), stagingPrefix));

    const review = { tauDirectory, recordDirectory, stagingDirectory, paths };

    await populateReview(review);

    return review;
  } catch (error) {
    await rm(recordDirectory, { recursive: true, force: true });

    if (stagingDirectory !== '') {
      await rm(stagingDirectory, { recursive: true, force: true });
    }

    throw error;
  }
};

const isOwnStagingDirectory = (directory: string) =>
  dirname(directory) === tmpdir() && basename(directory).startsWith(stagingPrefix);

export const readReview = async (cwd: string, directory: string): Promise<Review> => {
  const root = await findTauRoot(cwd, 'draft_review');
  const child = locateTauChild(root, recordParent, recordPrefix, resolve(cwd, directory));

  if (child.kind !== 'child') {
    throw new Error(
      `draft_review directory is not a review record under .tau/${recordParent}: ${directory}`,
    );
  }

  const recordDirectory = join(root, '.tau', recordParent, child.name);
  const manifestPath = join(recordDirectory, manifestName);
  let content: string;

  try {
    content = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`draft_review found no review record at ${manifestPath}`, { cause: error });
    }

    throw error;
  }

  const manifest = parseReviewManifest(manifestPath, content);

  const { stagingDirectory, paths } = manifest;

  if (!isOwnStagingDirectory(stagingDirectory)) {
    throw new Error(
      `draft_review record names a staging directory it did not create: ${manifestPath}`,
    );
  }

  if (paths.some(climbsOut)) {
    throw new Error(`draft_review record names a path outside .tau: ${manifestPath}`);
  }

  const tauDirectory = await realpath(join(root, '.tau'));

  return { tauDirectory, recordDirectory, stagingDirectory, paths };
};

export const removeReview = async (review: Review): Promise<void> => {
  await rm(review.stagingDirectory, { recursive: true, force: true });
  await rm(review.recordDirectory, { recursive: true, force: true });
};
