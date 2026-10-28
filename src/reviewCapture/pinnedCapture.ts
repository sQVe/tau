import { rm, writeFile } from 'node:fs/promises';

import { captureTarget, readHead } from './capture.js';
import { captureFixTarget } from './fixCapture.js';
import type { FixTarget } from './fixCapture.js';
import { captureChainedFix } from './fixChain.js';
import type { ReviewCapture } from './fixChain.js';
import { decideFreshness } from './freshness.js';
import type { CaptureState, Freshness } from './freshness.js';
import type { PinnedTarget } from './target.js';

const captureFix = (root: string, target: FixTarget): Promise<ReviewCapture> => {
  const { predecessor } = target;

  return predecessor === undefined
    ? captureFixTarget(root, target)
    : captureChainedFix(root, { ...target, predecessor });
};

export const captureReview = (root: string, target: PinnedTarget): Promise<ReviewCapture> =>
  target.kind === 'fix' ? captureFix(root, target) : captureTarget(root, target);

// Captures the recorded target again into recheckFile and compares it, and HEAD, with the record.
// A failed recapture removes recheckFile, so no stale file stands for the current target.
export const checkFreshness = async (
  root: string,
  recorded: CaptureState & { target: PinnedTarget },
  recheckFile: string,
): Promise<Freshness> => {
  const capture = await captureReview(root, recorded.target);
  const current = await readHead(root);

  if (current.head === undefined) {
    await rm(recheckFile, { force: true });

    const captureErrors = [...capture.errors, current.error];

    return decideFreshness({ recorded, current: undefined, captureErrors });
  }

  if (capture.errors.length > 0) {
    await rm(recheckFile, { force: true });

    return decideFreshness({ recorded, current: undefined, captureErrors: capture.errors });
  }

  await writeFile(recheckFile, capture.bytes);

  const currentState = { hash: capture.hash, head: current.head };

  return decideFreshness({ recorded, current: currentState, captureErrors: [] });
};
