import { errorMessage } from '../errors.js';
import { readCompletedCapture } from './completedCapture.js';
import type { EvidenceGap } from './evidenceDecisions.js';
import type { ReviewCapture } from './fixChain.js';
import type { Freshness } from './freshness.js';
import { recaptureReview } from './pinnedCapture.js';
import type { CaptureRecord } from './record.js';
import { readRecord, requireRecord } from './recordRead.js';
import type { RecordRead } from './recordRead.js';
import { checkReviewDirectory } from './reviewDirectory.js';
import { readRecheck } from './savedRecapture.js';
import type { RecheckRead } from './savedRecapture.js';

export interface ReviewInspection {
  directory: string;
  generation: EvidenceGap[];
  record: CaptureRecord;
  recheck: RecheckRead;
  capture: ReviewCapture;
  freshness: Freshness;
}

const generationGaps = async (
  root: string,
  directory: string,
  read: RecordRead,
): Promise<EvidenceGap[]> => {
  const decision = await readCompletedCapture(root, directory, read);

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

const readRecheckStatus = async (root: string, directory: string): Promise<RecheckRead> => {
  try {
    const { bytes, hash } = await readRecheck(root, directory);

    return { status: 'read', bytes, hash };
  } catch (error) {
    return { status: 'error', error: errorMessage(error) };
  }
};

export const inspectReview = async (
  root: string,
  requestedDirectory: string,
): Promise<ReviewInspection> => {
  const directory = await checkReviewDirectory(root, requestedDirectory);
  const read = await readRecord(directory);
  const generation = await generationGaps(root, directory, read);
  const record = requireRecord(read).record;
  const recheck = await readRecheckStatus(root, directory);
  const { capture, freshness } = await recaptureReview(root, record);

  return { directory, generation, record, recheck, capture, freshness };
};
