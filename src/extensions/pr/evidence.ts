import { createHash } from 'node:crypto';
import { constants, lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, isMissingFile } from '../../errors.js';
import type { Runtime } from '../../github.js';
import { readReviewEvidence } from '../../reviewCapture/evidence.js';
import type { ReviewEvidence } from '../../reviewCapture/evidence.js';
import { checkReviewDirectory } from '../../reviewCapture/reviewDirectory.js';
import { checkLogGaps, matchCheckLog } from './evidenceDecisions.js';
import type { CheckIdentity, CheckLog, PublicationGap } from './evidenceDecisions.js';
import { readGit, readGitBytes } from './git.js';
import { readReuse } from './reuse.js';
import type { ReuseResult } from './reuse.js';
import { readTarget } from './target.js';
import type { Target } from './target.js';

export interface PublicationRequest {
  remote?: string;
  base?: string;
  review?: string;
}

export interface PublicationEvidence {
  target: Target | null;
  branch: string | null;
  subjects: string[];
  reuse: ReuseResult | null;
  review: ReviewEvidence | null;
  checks: CheckLog[];
  gaps: PublicationGap[];
}

const readFailure = (
  kind: 'target' | 'branch' | 'subjects' | 'reuse' | 'review' | 'checks',
  error: unknown,
): PublicationGap => ({
  kind,
  reason: errorMessage(error),
});

const readReview = async (
  root: string,
  request: PublicationRequest,
  evidence: PublicationEvidence,
) => {
  if (request.review === undefined) {
    evidence.gaps.push({ kind: 'noReview' });

    return;
  }

  let directory: string;

  try {
    directory = await checkReviewDirectory(root, request.review);
  } catch (error) {
    evidence.gaps.push(readFailure('review', error));

    return;
  }

  // Reuse must read the saved recheck before the evidence reader recaptures freshness.
  if (evidence.target !== null) {
    try {
      evidence.reuse = await readReuse(root, { directory, mergeBase: evidence.target.mergeBase });

      if (evidence.reuse.status === 'mismatch') {
        evidence.gaps.push({ kind: 'reuseMismatch', reasons: evidence.reuse.reasons });
      }
    } catch (error) {
      evidence.gaps.push(readFailure('reuse', error));
    }
  }

  try {
    evidence.review = await readReviewEvidence(root, directory);

    evidence.gaps.push(
      ...evidence.review.gaps.map((gap): PublicationGap => ({ kind: 'reviewEvidence', gap })),
    );
  } catch (error) {
    evidence.gaps.push(readFailure('review', error));
  }
};

const hashOutput = async (root: string, commandArguments: string[]) => {
  const bytes = await readGitBytes(root, commandArguments);

  return createHash('sha256').update(bytes).digest('hex');
};

const readCheckIdentity = async (root: string, target: Target): Promise<CheckIdentity> => ({
  head: await readGit(root, ['rev-parse', 'HEAD']),
  status: await hashOutput(root, ['status', '--porcelain']),
  diff: await hashOutput(root, ['diff', target.mergeBase, 'HEAD']),
});

const readDirectory = async (path: string) => {
  try {
    const entry = await lstat(path);

    if (!entry.isDirectory()) {
      throw new Error(`Not a regular directory: ${path}`);
    }

    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const readCheckLog = async (path: string, current: CheckIdentity | null): Promise<CheckLog> => {
  try {
    const entry = await lstat(path);

    if (!entry.isFile()) {
      throw new Error(`Not a regular check log: ${path}`);
    }

    const text = await readFile(path, {
      encoding: 'utf8',
      flag: constants.O_RDONLY | constants.O_NOFOLLOW,
    });

    return matchCheckLog(path, text, current);
  } catch (error) {
    return {
      path,
      matches: false,
      reasons: [{ field: 'read', reason: errorMessage(error) }],
      excerpt: null,
      truncated: false,
    };
  }
};

const readRunChecks = async (directory: string, current: CheckIdentity | null) => {
  const entries = await readDirectory(directory);

  const paths = entries
    .filter((entry) => entry.name.endsWith('.log'))
    .map((entry) => join(directory, entry.name))
    .toSorted();

  return Promise.all(paths.map((path) => readCheckLog(path, current)));
};

const readChecks = async (root: string, evidence: PublicationEvidence) => {
  let current: CheckIdentity | null = null;

  if (evidence.target !== null) {
    try {
      current = await readCheckIdentity(root, evidence.target);
    } catch (error) {
      evidence.gaps.push(readFailure('checks', error));
    }
  }

  try {
    await readDirectory(join(root, '.tau'));

    const directory = join(root, '.tau', 'pr');
    const entries = await readDirectory(directory);

    const runs = entries
      .filter((entry) => entry.name.startsWith('run-'))
      .toSorted((left, right) => left.name.localeCompare(right.name));

    for (const run of runs) {
      try {
        const runDirectory = join(directory, run.name);

        // oxlint-disable-next-line no-await-in-loop -- reject linked run directories before reading their checks.
        await readDirectory(runDirectory);

        // oxlint-disable-next-line no-await-in-loop -- read one run at a time and retain failures from each.
        evidence.checks.push(...(await readRunChecks(join(runDirectory, 'checks'), current)));
      } catch (error) {
        evidence.gaps.push(readFailure('checks', error));
      }
    }
  } catch (error) {
    evidence.gaps.push(readFailure('checks', error));
  }

  evidence.gaps.push(...checkLogGaps(evidence.checks));
};

export const readPublicationEvidence = async (
  runtime: Runtime,
  root: string,
  request: PublicationRequest,
): Promise<PublicationEvidence> => {
  const evidence: PublicationEvidence = {
    target: null,
    branch: null,
    subjects: [],
    reuse: null,
    review: null,
    checks: [],
    gaps: [],
  };

  try {
    evidence.target = await readTarget(
      { ...runtime, cwd: root },
      { remote: request.remote, base: request.base },
    );
  } catch (error) {
    evidence.gaps.push(readFailure('target', error));
  }

  try {
    evidence.branch = await readGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch (error) {
    evidence.gaps.push(readFailure('branch', error));
  }

  if (evidence.target !== null) {
    try {
      const subjects = await readGit(root, [
        'log',
        '--format=%s',
        `${evidence.target.mergeBase}..HEAD`,
      ]);

      evidence.subjects = subjects.split('\n').filter((subject) => subject !== '');
    } catch (error) {
      evidence.gaps.push(readFailure('subjects', error));
    }
  }

  await readReview(root, request, evidence);
  await readChecks(root, evidence);

  return evidence;
};
