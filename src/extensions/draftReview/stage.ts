import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { Type } from 'typebox';

import { isMissingFile } from '../../errors.js';
import { parseVersionedRecord, savedVersion, writeRecord } from '../../record.js';
import { isRecord } from '../../schema.js';
import {
  climbsOut,
  createFreshTauDirectory,
  findTauRoot,
  requireTauChild,
} from '../../tauDirectory.js';
import { stagedNames } from './reviewDecisions.js';

type ReviewTerminal = { state: 'starting' } | { state: 'open'; address: string };

export interface Review {
  // The real `.tau` directory the paths are relative to.
  tauDirectory: string;
  // Holds the review record and the original content of each file.
  recordDirectory: string;
  // A directory outside Git that tuicr opens, with each file under its staged path.
  stagingDirectory: string;
  paths: string[];
  // The path of each file in the staging directory, in the order of `paths`.
  stagedPaths: string[];
  // The hc terminal state: null for a manual review, starting before `hc run`, then its address.
  terminal: ReviewTerminal | null;
}

export interface ReviewManifest {
  version: typeof manifestVersion;
  stagingDirectory: string;
  paths: string[];
  stagedPaths: string[];
  terminal: ReviewTerminal | null;
}

const recordParent = 'draft-review';
const recordPrefix = 'review-';
const manifestName = 'review.json';
const manifestVersion = 4;

const terminalSchema = Type.Union([
  Type.Object({ state: Type.Literal('starting') }, { additionalProperties: false }),
  Type.Object(
    { state: Type.Literal('open'), address: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

const manifestSchema = Type.Object(
  {
    version: Type.Literal(manifestVersion),
    stagingDirectory: Type.String({ minLength: 1 }),
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    stagedPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    terminal: Type.Union([Type.Null(), terminalSchema]),
  },
  { additionalProperties: false },
);

// A Tau before this one opened tuicr in a herdr pane it named itself. That placement is gone, and
// its record holds no hc address to wait for, so collect refuses it and keeps the comments.
const firstHerdrRecordVersion = 1;
const lastHerdrRecordVersion = 3;

const isHerdrRecordVersion = (version: unknown): boolean =>
  typeof version === 'number' &&
  version >= firstHerdrRecordVersion &&
  version <= lastHerdrRecordVersion;

const refuseHerdrRecord = (value: unknown): string | undefined => {
  if (!isHerdrRecordVersion(savedVersion(value))) {
    return undefined;
  }

  const stagingDirectory =
    isRecord(value) && typeof value['stagingDirectory'] === 'string'
      ? value['stagingDirectory']
      : 'an unknown staging directory';

  throw new Error(
    `This review was saved by a Tau that ran on herdr, so this Tau cannot collect it. Its tuicr comments stay in ${stagingDirectory}. Open a new review from the current files.`,
  );
};

export const parseReviewManifest = (path: string, content: string): ReviewManifest => {
  const manifest = parseVersionedRecord(path, content, {
    label: 'review record',
    version: manifestVersion,
    schema: manifestSchema,
    check: refuseHerdrRecord,
  });

  // A staged path paired with the wrong file would write one draft's text over another.
  const expected = stagedNames(manifest.paths);
  const matches = expected.every((name, index) => manifest.stagedPaths[index] === name);

  if (!matches || manifest.stagedPaths.length !== expected.length) {
    throw new Error(
      `Malformed review record ${path}: stagedPaths must hold the staged name of each path.`,
    );
  }

  return manifest;
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

  if (stats.nlink > 1) {
    throw new Error(`draft_review path has another hard link: ${requested}`);
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

export const stagedPathOf = (review: Review, path: string): string => {
  const stagedPath = review.stagedPaths[review.paths.indexOf(path)];

  if (stagedPath === undefined) {
    throw new Error(`Review record ${review.recordDirectory} has no staged path for ${path}.`);
  }

  return stagedPath;
};

const copyInto = async (from: string, to: string) => {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
};

const writeManifest = async (review: Review, terminal: ReviewTerminal | null) => {
  const { recordDirectory, stagingDirectory, paths, stagedPaths } = review;
  const manifest = { version: manifestVersion, stagingDirectory, paths, stagedPaths, terminal };

  const target = join(recordDirectory, manifestName);

  await writeRecord(target, manifest);
};

// Saved before `hc run`, so a record left by a failed address save says the terminal is starting
// and collect refuses it instead of deleting comments under a live tuicr.
export const saveStartingTerminal = async (review: Review): Promise<void> => {
  const terminal: ReviewTerminal = { state: 'starting' };

  await writeManifest(review, terminal);
  review.terminal = terminal;
};

export const saveTerminal = async (review: Review, address: string): Promise<void> => {
  const terminal: ReviewTerminal = { state: 'open', address };

  await writeManifest(review, terminal);
  review.terminal = terminal;
};

const populateReview = async (review: Review) => {
  const { tauDirectory, recordDirectory, stagingDirectory, paths } = review;

  // Staging copies the saved original, not the live file, so both start from one snapshot.
  const copies = await Promise.allSettled(
    paths.map(async (path) => {
      const original = join(recordDirectory, 'originals', path);

      await copyInto(join(tauDirectory, path), original);
      await copyInto(original, join(stagingDirectory, stagedPathOf(review, path)));
    }),
  );

  const failed = copies.find((copy) => copy.status === 'rejected');

  if (failed) {
    throw failed.reason;
  }

  await writeManifest(review, null);
};

export const stageReview = async (cwd: string, requested: readonly string[]): Promise<Review> => {
  const root = await findTauRoot(cwd, 'draft_review');
  const tauDirectory = await realpath(join(root, '.tau'));
  const paths = await reviewablePaths(tauDirectory, requested, cwd);
  const recordDirectory = await createFreshTauDirectory(root, recordParent, recordPrefix);
  let stagingDirectory = '';

  try {
    stagingDirectory = await mkdtemp(join(tmpdir(), stagingPrefix));

    const stagedPaths = stagedNames(paths);

    const review = {
      tauDirectory,
      recordDirectory,
      stagingDirectory,
      paths,
      stagedPaths,
      terminal: null,
    };

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

  const name = requireTauChild(
    root,
    recordParent,
    recordPrefix,
    resolve(cwd, directory),
    'The draft_review directory',
  );

  const recordDirectory = join(root, '.tau', recordParent, name);
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

  const { stagingDirectory, paths, stagedPaths, terminal } = manifest;

  if (!isOwnStagingDirectory(stagingDirectory)) {
    throw new Error(
      `draft_review record names a staging directory it did not create: ${manifestPath}`,
    );
  }

  if (paths.some(climbsOut)) {
    throw new Error(`draft_review record names a path outside .tau: ${manifestPath}`);
  }

  const tauDirectory = await realpath(join(root, '.tau'));

  return { tauDirectory, recordDirectory, stagingDirectory, paths, stagedPaths, terminal };
};

export const removeReview = async (review: Review): Promise<void> => {
  await rm(review.stagingDirectory, { recursive: true, force: true });
  await rm(review.recordDirectory, { recursive: true, force: true });
};
