import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureTarget, readHead } from './capture.js';
import { captureFixTarget } from './fixCapture.js';
import type { FixTarget } from './fixCapture.js';
import { captureChainedFix } from './fixChain.js';
import type { ReviewCapture } from './fixChain.js';
import { decideFreshness } from './freshness.js';
import type { CaptureState, Freshness } from './freshness.js';
import { readCaptureRecord, recheckFileName } from './record.js';
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
  recheckFile: string,
): Promise<ReviewRecapture> => {
  const capture = await captureReview(root, recorded.target);
  const head = await readHead(root);

  if (head.head === undefined) {
    await rm(recheckFile, { force: true });

    const captureErrors = [...capture.errors, head.error];
    const freshness = decideFreshness({ recorded, current: undefined, captureErrors });

    return { capture, freshness };
  }

  if (capture.errors.length > 0) {
    await rm(recheckFile, { force: true });

    const freshness = decideFreshness({
      recorded,
      current: undefined,
      captureErrors: capture.errors,
    });

    return { capture, freshness };
  }

  await writeFile(recheckFile, capture.bytes);

  const currentState = { hash: capture.hash, head: head.head };
  const freshness = decideFreshness({ recorded, current: currentState, captureErrors: [] });

  return { capture, freshness };
};

const checkFreshness = async (
  root: string,
  recorded: CaptureState & { target: PinnedTarget },
  recheckFile: string,
): Promise<Freshness> => {
  const { freshness } = await recaptureReview(root, recorded, recheckFile);

  return freshness;
};

export const checkReviewFreshness = async (root: string, directory: string): Promise<Freshness> => {
  const checked = await checkReviewDirectory(root, directory);
  const record = await readCaptureRecord(checked);

  return checkFreshness(root, record, join(checked, recheckFileName));
};
