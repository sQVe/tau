import { createHash } from 'node:crypto';
import { constants, lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { listSavedLogs } from '../../checkRecord/checkRecord.js';
import { readCheckState } from '../../checkRecord/identity.js';
import type { CommandRuntime } from '../../command.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { readFullCheckArgv } from '../../config/fullCheck.js';
import { errorMessage, isMissingFile } from '../../errors.js';
import { readGit, runGit } from '../../git.js';
import { readOriginRepository } from '../../github/repositoryTarget.js';
import { configRepositoryKey } from '../../github/repositoryTargetDecisions.js';
import { readReviewEvidence, scanMarkers } from '../../reviewCapture/evidence.js';
import type { MarkerLine, ReviewEvidence } from '../../reviewCapture/evidence.js';
import type { CoverageDecision, CoverageLinkRequest } from '../../reviewCapture/reviewCapture.js';
import { checkReviewDirectory } from '../../reviewCapture/reviewCapture.js';
import { readChainCoverage } from './coverage.js';
import {
  checkLogGaps,
  decideFullCheck,
  excerptBody,
  matchCheckLog,
  selectLatestChecks,
} from './evidenceDecisions.js';
import type {
  CheckHeaderIdentity,
  CheckLog,
  FullCheckDecision,
  ModifiedCheckLog,
  PublicationGap,
} from './evidenceDecisions.js';
import { readReuse } from './reuse.js';
import type { ReuseResult } from './reuse.js';
import { readTarget } from './target.js';
import type { Target } from './target.js';

export interface PublicationRequest {
  remote?: string;
  base?: string;
  review?: string;
  chain?: CoverageLinkRequest[];
}

export interface PublicationConfig {
  location: ConfigLocation;
  ui: ConfigWarnings;
}

type FullCheckEvidence = FullCheckDecision & { excerpt?: string; truncated?: boolean };

export interface PublicationEvidence {
  target: Target | null;
  branch: string | null;
  subjects: string[];
  reuse: ReuseResult | null;
  review: ReviewEvidence | null;
  coverage?: CoverageDecision | null;
  markers: MarkerLine[];
  checks: CheckLog[];
  fullCheck: FullCheckEvidence | null;
  gaps: PublicationGap[];
}

const readFailure = (
  kind: 'target' | 'branch' | 'subjects' | 'reuse' | 'review' | 'markers' | 'checks' | 'coverage',
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

// Coverage is read-only, so it runs after reuse and freshness have read the review.
const readCoverageEvidence = async (
  root: string,
  evidence: PublicationEvidence,
  chain: CoverageLinkRequest[],
) => {
  if (evidence.target === null) {
    evidence.coverage = null;

    return;
  }

  try {
    const coverage = await readChainCoverage(root, {
      chain,
      mergeBase: evidence.target.mergeBase,
    });

    evidence.coverage = coverage;

    if (coverage.status !== 'match') {
      evidence.gaps.push({
        kind: 'coverageMismatch',
        status: coverage.status,
        reasons: coverage.reasons,
      });
    }
  } catch (error) {
    evidence.coverage = null;
    evidence.gaps.push(readFailure('coverage', error));
  }
};

const readMarkers = async (root: string, evidence: PublicationEvidence, mergeBase: string) => {
  try {
    const diff = await readGit(root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      mergeBase,
      'HEAD',
    ]);

    const scan = scanMarkers(diff);

    evidence.markers = scan.items;

    evidence.gaps.push(
      ...scan.gaps.map((gap): PublicationGap => ({ kind: 'reviewEvidence', gap })),
    );
  } catch (error) {
    evidence.gaps.push(readFailure('markers', error));
  }
};

const hashOutput = async (root: string, commandArguments: string[]) => {
  const result = await runGit(root, commandArguments);

  if (result.exitCode !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return createHash('sha256').update(result.stdout).digest('hex');
};

const readHeaderIdentity = async (
  root: string,
  mergeBase: string,
): Promise<CheckHeaderIdentity> => ({
  head: await readGit(root, ['rev-parse', 'HEAD']),
  status: await hashOutput(root, ['--no-optional-locks', 'status', '--porcelain']),
  diff: await hashOutput(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    mergeBase,
    'HEAD',
  ]),
});

export const readCheckHeader = async (
  root: string,
  mergeBase: string | undefined,
): Promise<{ lines: string[] }> => {
  if (mergeBase === undefined) {
    throw new Error('checkHeader needs mergeBase.');
  }

  const commit = await readGit(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${mergeBase}^{commit}`,
  ]);

  const identity = await readHeaderIdentity(root, commit);

  return {
    lines: [`HEAD: ${identity.head}`, `Status: ${identity.status}`, `Diff: ${identity.diff}`],
  };
};

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

const readCheckLog = async (
  path: string,
  current: CheckHeaderIdentity | null,
): Promise<ModifiedCheckLog> => {
  let modifiedAt: number | null = null;
  let check: CheckLog;

  try {
    const entry = await lstat(path);

    modifiedAt = entry.mtimeMs;

    if (!entry.isFile()) {
      throw new Error(`Not a regular check log: ${path}`);
    }

    const text = await readFile(path, {
      encoding: 'utf8',
      flag: constants.O_RDONLY | constants.O_NOFOLLOW,
    });

    check = matchCheckLog(path, text, current);
  } catch (error) {
    check = {
      path,
      matches: false,
      reasons: [{ field: 'read', reason: errorMessage(error) }],
      excerpt: null,
      truncated: false,
    };
  }

  return { name: basename(path), modifiedAt, check };
};

const readRunChecks = async (directory: string, current: CheckHeaderIdentity | null) => {
  const entries = await readDirectory(directory);

  const paths = entries
    .filter((entry) => entry.name.endsWith('.log'))
    .map((entry) => join(directory, entry.name))
    .toSorted();

  return Promise.all(paths.map((path) => readCheckLog(path, current)));
};

const readChecks = async (root: string, evidence: PublicationEvidence) => {
  let current: CheckHeaderIdentity | null = null;
  const logs: ModifiedCheckLog[] = [];

  if (evidence.target !== null) {
    try {
      current = await readHeaderIdentity(root, evidence.target.mergeBase);
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
        logs.push(...(await readRunChecks(join(runDirectory, 'checks'), current)));
      } catch (error) {
        evidence.gaps.push(readFailure('checks', error));
      }
    }
  } catch (error) {
    evidence.gaps.push(readFailure('checks', error));
  }

  evidence.checks = selectLatestChecks(logs);
  evidence.gaps.push(...checkLogGaps(evidence.checks, evidence.fullCheck));
};

const readLogExcerpt = async (logPath: string) => {
  const text = await readFile(logPath, 'utf8');
  const body = text.split('\n');

  if (body.at(-1) === '') {
    body.pop();
  }

  return excerptBody(body);
};

const readFullCheckCommand = async (runtime: CommandRuntime, config: PublicationConfig) => {
  const origin = await readOriginRepository(runtime);

  const repositoryKey =
    origin.status === 'named' ? configRepositoryKey(origin.repository) : undefined;

  return readFullCheckArgv(config.location, config.ui, repositoryKey);
};

const readFullCheck = async (
  runtime: CommandRuntime,
  root: string,
  evidence: PublicationEvidence,
  config: PublicationConfig,
) => {
  if (evidence.target === null) {
    return;
  }

  try {
    const state = await readCheckState(root);
    const saved = await listSavedLogs(join(root, '.tau', 'checks'));
    const argv = await readFullCheckCommand({ ...runtime, cwd: root }, config);
    const decision = decideFullCheck(state, argv, saved);

    evidence.fullCheck = decision;

    if (decision.status === 'passed' || decision.status === 'failed') {
      evidence.fullCheck = { ...decision, ...(await readLogExcerpt(decision.logPath)) };
    }

    if (decision.status !== 'passed') {
      evidence.gaps.push({ kind: 'fullCheck', status: decision.status });
    }
  } catch (error) {
    evidence.gaps.push(readFailure('checks', error));
  }
};

export const readPublicationEvidence = async (
  runtime: CommandRuntime,
  root: string,
  request: PublicationRequest,
  config: PublicationConfig,
): Promise<PublicationEvidence> => {
  const evidence: PublicationEvidence = {
    target: null,
    branch: null,
    subjects: [],
    reuse: null,
    review: null,
    markers: [],
    checks: [],
    fullCheck: null,
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

  if (evidence.target !== null) {
    await readMarkers(root, evidence, evidence.target.mergeBase);
  }

  await readReview(root, request, evidence);

  if (request.chain !== undefined) {
    await readCoverageEvidence(root, evidence, request.chain);
  }

  await readFullCheck(runtime, root, evidence, config);
  await readChecks(root, evidence);

  return evidence;
};
