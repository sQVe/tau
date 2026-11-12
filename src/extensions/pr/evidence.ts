import type { CommandRuntime } from '../../command.js';
import { errorMessage } from '../../errors.js';
import { readGit } from '../../git.js';
import { readInspectedEvidence, scanMarkers } from '../../reviewCapture/evidence.js';
import type { Marker, ReviewEvidence } from '../../reviewCapture/evidence.js';
import type {
  CoverageDecision,
  CoverageLinkRequest,
  ReviewInspection,
  Ownership,
} from '../../reviewCapture/reviewCapture.js';
import {
  checkReviewDirectory,
  fixedDiffOptions,
  inspectReview,
  readOwnership,
} from '../../reviewCapture/reviewCapture.js';
import { readCheckEvidence } from './checkEvidence.js';
import type { FullCheckEvidence, PublicationConfig } from './checkEvidence.js';
import { readChainEvidence } from './evidenceChain.js';
import type { CheckLog, PublicationGap } from './evidenceDecisions.js';
import { decideSavedReuse } from './reuse.js';
import type { ReuseResult } from './reuse.js';
import { decideReviewReuse } from './reuseDecisions.js';
import { readTarget } from './target.js';
import type { Target } from './target.js';

export interface PublicationRequest {
  remote?: string;
  base?: string;
  review?: string;
}

interface PublicationReviewEvidence extends ReviewEvidence {
  reusable: boolean;
  reusableReasons: string[];
}

export interface PublicationEvidence {
  ownership: Ownership;
  target: Target | null;
  branch: string | null;
  subjects: string[];
  reuse: ReuseResult | null;
  review: PublicationReviewEvidence | null;
  chain: CoverageLinkRequest[] | null;
  coverage: CoverageDecision | null;
  markers: Marker[];
  checks: CheckLog[];
  fullCheck: FullCheckEvidence | null;
  gaps: PublicationGap[];
}

const readFailure = (
  kind: 'target' | 'branch' | 'subjects' | 'reuse' | 'review' | 'markers',
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
  const inspected = evidence.chain?.[0]?.directory ?? request.review;

  if (inspected === undefined) {
    evidence.gaps.push({ kind: 'noReview' });

    return;
  }

  let directory: string;

  try {
    directory = await checkReviewDirectory(root, inspected);
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
    const review = await readInspectedEvidence(root, inspection);

    const decision = decideReviewReuse({
      reuse: evidence.reuse,
      freshness: review.freshness,
      reports: evidence.reuse?.reports ?? null,
      gaps: review.gaps,
    });

    evidence.review = {
      ...review,
      reusable: decision.reusable,
      reusableReasons: decision.reasons,
    };

    evidence.gaps.push(
      ...evidence.review.gaps.map((gap): PublicationGap => ({ kind: 'reviewEvidence', gap })),
    );
  } catch (error) {
    evidence.gaps.push(readFailure('review', error));
  }
};

const readChain = async (
  root: string,
  request: PublicationRequest,
  evidence: PublicationEvidence,
) => {
  if (evidence.target === null) {
    return;
  }

  const { chain, coverage, gaps } = await readChainEvidence(
    root,
    evidence.target.mergeBase,
    request.review,
  );

  evidence.chain = chain;
  evidence.coverage = coverage;
  evidence.gaps.push(...gaps);
};

const readMarkers = async (root: string, evidence: PublicationEvidence, mergeBase: string) => {
  try {
    const diff = await readGit(root, ['diff', ...fixedDiffOptions, mergeBase, 'HEAD']);

    const scan = scanMarkers(diff);

    evidence.markers = scan.items;

    evidence.gaps.push(
      ...scan.gaps.map((gap): PublicationGap => ({ kind: 'reviewEvidence', gap })),
    );
  } catch (error) {
    evidence.gaps.push(readFailure('markers', error));
  }
};

const readPublicationTarget = async (
  runtime: CommandRuntime,
  request: PublicationRequest,
): Promise<Pick<PublicationEvidence, 'target' | 'ownership' | 'gaps'>> => {
  try {
    const target = await readTarget(runtime, { remote: request.remote, base: request.base });
    const pr = target.pr === null ? null : { host: target.host, author: target.pr.author };
    const ownership = await readOwnership(runtime, { base: target.mergeBase, head: 'HEAD' }, pr);

    return { target, ownership, gaps: [] };
  } catch (error) {
    return {
      target: null,
      ownership: { status: 'unclear', reasons: [errorMessage(error)] },
      gaps: [readFailure('target', error)],
    };
  }
};

export const readPublicationEvidence = async (
  runtime: CommandRuntime,
  root: string,
  request: PublicationRequest,
  config: PublicationConfig,
): Promise<PublicationEvidence> => {
  const evidence: PublicationEvidence = {
    ...(await readPublicationTarget({ ...runtime, cwd: root }, request)),
    branch: null,
    subjects: [],
    reuse: null,
    review: null,
    chain: null,
    coverage: null,
    markers: [],
    checks: [],
    fullCheck: null,
  };

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

  await readChain(root, request, evidence);
  await readReview(root, request, evidence);

  const checkEvidence = await readCheckEvidence(root, evidence.target?.mergeBase, config);

  evidence.checks = checkEvidence.checks;
  evidence.fullCheck = checkEvidence.fullCheck;
  evidence.gaps.push(...checkEvidence.gaps);

  return evidence;
};
