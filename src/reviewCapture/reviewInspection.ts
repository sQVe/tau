import { join } from 'node:path';

import { errorMessage } from '../errors.js';
import { hashOf, readCompletedCapture, readOptionalBytes } from './completedCapture.js';
import type { EvidenceGap } from './evidenceDecisions.js';
import type { ReviewCapture } from './fixChain.js';
import type { Freshness } from './freshness.js';
import { recaptureReview } from './pinnedCapture.js';
import { readCaptureRecord, recheckFileName } from './record.js';
import type { CaptureRecord } from './record.js';
import { checkReviewDirectory } from './reviewDirectory.js';

type RecheckRead =
  | { status: 'read'; bytes: Buffer; hash: string }
  | { status: 'error'; error: string };

export interface ReviewInspection {
  directory: string;
  generation: EvidenceGap[];
  record: CaptureRecord;
  recheck: RecheckRead;
  capture: ReviewCapture;
  freshness: Freshness;
}

const generationGaps = async (root: string, directory: string): Promise<EvidenceGap[]> => {
  const decision = await readCompletedCapture(root, directory);

  if (decision.status === 'completed' || decision.status === 'legacy') {
    return [];
  }

  if (decision.status === 'incomplete') {
    throw new Error(
      `The capture in ${directory} is incomplete, so it has no evidence. Prepare a new review.\n- ${decision.reasons.join('\n- ')}`,
    );
  }

  return [{ kind: 'generation', status: decision.status, reasons: decision.reasons }];
};

const readRecheck = async (root: string, directory: string): Promise<RecheckRead> => {
  const path = join(directory, recheckFileName);

  try {
    const bytes = await readOptionalBytes(path);

    if (bytes === undefined) {
      return {
        status: 'error',
        error: `No recheck.diff at ${path}. Run code_review freshness first.`,
      };
    }

    return { status: 'read', bytes, hash: await hashOf(root, bytes) };
  } catch (error) {
    return { status: 'error', error: errorMessage(error) };
  }
};

export const inspectReview = async (
  root: string,
  requestedDirectory: string,
): Promise<ReviewInspection> => {
  const directory = await checkReviewDirectory(root, requestedDirectory);
  const generation = await generationGaps(root, directory);
  const record = await readCaptureRecord(directory);
  const recheck = await readRecheck(root, directory);
  const { capture, freshness } = await recaptureReview(root, record);

  return { directory, generation, record, recheck, capture, freshness };
};
