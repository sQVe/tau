import type { CommandRuntime } from '../../command.js';
import { errorMessage } from '../../errors.js';
import { readGit } from '../../git.js';
import { readInspectedEvidence, scanMarkers } from '../../reviewCapture/evidence.js';
import type { MarkerLine, ReviewEvidence } from '../../reviewCapture/evidence.js';
import type {
  CoverageDecision,
  CoverageLinkRequest,
  ReviewInspection,
} from '../../reviewCapture/reviewCapture.js';
import { checkReviewDirectory, inspectReview } from '../../reviewCapture/reviewCapture.js';
import { readCheckEvidence } from './checkEvidence.js';
import type { FullCheckEvidence, PublicationConfig } from './checkEvidence.js';
import { readChainCoverage } from './coverage.js';
import type { CheckLog, PublicationGap } from './evidenceDecisions.js';
import { decideSavedReuse } from './reuse.js';
import type { ReuseResult } from './reuse.js';
import { readTarget } from './target.js';
import type { Target } from './target.js';

export interface PublicationRequest {
  remote?: string;
  base?: string;
  review?: string;
  chain?: CoverageLinkRequest[];
}

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
  kind: 'target' | 'branch' | 'subjects' | 'reuse' | 'review' | 'markers' | 'coverage',
  error: unknown,
): PublicationGap => ({
  kind,
  reason: errorMessage(error),
});

const readInspectionReuse = async (
  root: string,
  inspection: ReviewInspection,
  mergeBase: string,
  evidence: PublicationEvidence,
) => {
  if (inspection.recheck.status === 'error') {
    evidence.gaps.push({ kind: 'reuse', reason: inspection.recheck.error });

    return;
  }

  try {
    evidence.reuse = await decideSavedReuse(
      root,
      {
        directory: inspection.directory,
        recordedBase: inspection.record.base,
        recordedHash: inspection.record.hash,
        recheck: inspection.recheck.bytes,
        recheckHash: inspection.recheck.hash,
      },
      mergeBase,
    );

    if (evidence.reuse.status === 'mismatch') {
      evidence.gaps.push({ kind: 'reuseMismatch', reasons: evidence.reuse.reasons });
    }
  } catch (error) {
    evidence.gaps.push(readFailure('reuse', error));
  }
};

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

  let inspection: ReviewInspection;

  try {
    inspection = await inspectReview(root, directory);
  } catch (error) {
    if (evidence.target !== null) {
      evidence.gaps.push(readFailure('reuse', error));
    }

    evidence.gaps.push(readFailure('review', error));

    return;
  }

  if (evidence.target !== null) {
    await readInspectionReuse(root, inspection, evidence.target.mergeBase, evidence);
  }

  try {
    evidence.review = await readInspectedEvidence(root, inspection);

    evidence.gaps.push(
      ...evidence.review.gaps.map((gap): PublicationGap => ({ kind: 'reviewEvidence', gap })),
    );
  } catch (error) {
    evidence.gaps.push(readFailure('review', error));
  }
};

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

  const checkEvidence = await readCheckEvidence(root, evidence.target?.mergeBase, config);

  evidence.checks = checkEvidence.checks;
  evidence.fullCheck = checkEvidence.fullCheck;
  evidence.gaps.push(...checkEvidence.gaps);

  return evidence;
};
