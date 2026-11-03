import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureTarget, readHead } from './capture.js';
import { captureFixTarget } from './fixCapture.js';
import type { FixTarget } from './fixCapture.js';
import { captureChainedFix } from './fixChain.js';
import type { ReviewCapture } from './fixChain.js';
import { decideFreshness } from './freshness.js';
import type { CaptureState, Freshness } from './freshness.js';
import { recheckFileName } from './record.js';
import { readRecord, requireRecord } from './recordRead.js';
import { checkReviewDirectory } from './reviewDirectory.js';
import type { PinnedTarget } from './target.js';

export interface ReviewRecapture {
  capture: ReviewCapture;
  freshness: Freshness;
}

const captureFix = (root: string, target: FixTarget): Promise<ReviewCapture> => {
  const { predecessor } = target;

  return predecessor === undefined
    ? captureFixTarget(root, target)
    : captureChainedFix(root, { ...target, predecessor });
};

export const captureReview = (root: string, target: PinnedTarget): Promise<ReviewCapture> =>
  target.kind === 'fix' ? captureFix(root, target) : captureTarget(root, target);

export const recaptureReview = async (
  root: string,
  recorded: CaptureState & { target: PinnedTarget },
): Promise<ReviewRecapture> => {
  const capture = await captureReview(root, recorded.target);
  const head = await readHead(root);

  if (head.head === undefined) {
    const captureErrors = [...capture.errors, head.error];
    const freshness = decideFreshness({ recorded, current: undefined, captureErrors });

    return { capture, freshness };
  }

  if (capture.errors.length > 0) {
    const freshness = decideFreshness({
      recorded,
      current: undefined,
      captureErrors: capture.errors,
    });

    return { capture, freshness };
  }

  const currentState = { hash: capture.hash, head: head.head };
  const freshness = decideFreshness({ recorded, current: currentState, captureErrors: [] });

  return { capture, freshness };
};

export const checkReviewFreshness = async (root: string, directory: string): Promise<Freshness> => {
  const checked = await checkReviewDirectory(root, directory);
  const record = requireRecord(await readRecord(checked)).record;
  const { capture, freshness } = await recaptureReview(root, record);
  const recheckFile = join(checked, recheckFileName);

  if (freshness.status === 'unknown') {
    await rm(recheckFile, { force: true });
  } else {
    await writeFile(recheckFile, capture.bytes);
  }

  return freshness;
};
