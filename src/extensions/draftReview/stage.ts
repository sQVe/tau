import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { isMissingFile } from '../../errors.js';
import { parseVersionedRecord, writeRecord } from '../../record.js';
import { isRecord } from '../../schema.js';
import {
  climbsOut,
  createFreshTauDirectory,
  findTauRoot,
  requireTauChild,
} from '../../tauDirectory.js';
import { stagedNames } from './reviewDecisions.js';

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
  // Where tuicr runs, so a later collect can close it. `null` until a placement is saved.
  placement: SavedPlacement | null;
}

export interface ReviewManifest {
  version: 1 | 2 | typeof manifestVersion;
  stagingDirectory: string;
  paths: string[];
  stagedPaths: string[];
  placement: SavedPlacement | null;
}

const recordParent = 'draft-review';
const recordPrefix = 'review-';
const manifestName = 'review.json';
const manifestVersion = 3;

const placementSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('split'),
      terminalId: Type.String({ minLength: 1 }),
      processIds: Type.Optional(Type.Array(Type.Integer())),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('tab'),
      terminalId: Type.String({ minLength: 1 }),
      tabId: Type.String({ minLength: 1 }),
      agentTabId: Type.String({ minLength: 1 }),
      processIds: Type.Optional(Type.Array(Type.Integer())),
    },
    { additionalProperties: false },
  ),
]);

export type SavedPlacement = Static<typeof placementSchema>;

const versionOneSchema = Type.Object(
  {
    version: Type.Literal(1),
    stagingDirectory: Type.String({ minLength: 1 }),
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false },
);

const versionTwoSchema = Type.Object(
  {
    version: Type.Literal(2),
    stagingDirectory: Type.String({ minLength: 1 }),
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    placement: Type.Union([Type.Null(), placementSchema]),
  },
  { additionalProperties: false },
);

const manifestSchema = Type.Object(
  {
    version: Type.Literal(manifestVersion),
    stagingDirectory: Type.String({ minLength: 1 }),
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    stagedPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    placement: Type.Union([Type.Null(), placementSchema]),
  },
  { additionalProperties: false },
);

const versionOf = (value: unknown) => (isRecord(value) ? value['version'] : undefined);

const manifestSchemaFor = (value: unknown) => {
  const version = versionOf(value);

  if (version === 1) {
    return versionOneSchema;
  }

  return version === 2 ? versionTwoSchema : manifestSchema;
};

export const parseReviewManifest = (path: string, content: string): ReviewManifest => {
  const manifest = parseVersionedRecord(path, content, {
    label: 'review record',
    version: manifestVersion,
    schema: manifestSchemaFor,
  });

  // Versions 1 and 2 staged each file under its `.tau` path.
  if (manifest.version === 1) {
    return { ...manifest, stagedPaths: manifest.paths, placement: null };
  }

  if (manifest.version === 2) {
    return { ...manifest, stagedPaths: manifest.paths };
  }

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

const writeManifest = async (review: Review, placement: SavedPlacement | null) => {
  const { recordDirectory, stagingDirectory, paths, stagedPaths } = review;
  const manifest = { version: manifestVersion, stagingDirectory, paths, stagedPaths, placement };

  const target = join(recordDirectory, manifestName);

  await writeRecord(target, manifest);
};

export const savePlacement = async (review: Review, placement: SavedPlacement): Promise<void> => {
  await writeManifest(review, placement);
  review.placement = placement;
};

// Saves the tuicr process IDs before the terminal closes, so a collect retry can still wait for
// tuicr to exit.
export const saveProcessIds = async (review: Review, processIds: number[]): Promise<void> => {
  if (review.placement === null) {
    throw new Error(`Review record ${review.recordDirectory} has no placement to save into.`);
  }

  await savePlacement(review, { ...review.placement, processIds });
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
      placement: null,
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

  const { stagingDirectory, paths, stagedPaths, placement } = manifest;

  if (!isOwnStagingDirectory(stagingDirectory)) {
    throw new Error(
      `draft_review record names a staging directory it did not create: ${manifestPath}`,
    );
  }

  if (paths.some(climbsOut)) {
    throw new Error(`draft_review record names a path outside .tau: ${manifestPath}`);
  }

  const tauDirectory = await realpath(join(root, '.tau'));

  return { tauDirectory, recordDirectory, stagingDirectory, paths, stagedPaths, placement };
};

export const removeReview = async (review: Review): Promise<void> => {
  await rm(review.stagingDirectory, { recursive: true, force: true });
  await rm(review.recordDirectory, { recursive: true, force: true });
};
