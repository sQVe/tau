import { join } from 'node:path';

import type { DirectTarget } from './capture.js';
import { hashOf, readCompletedCapture, readOptionalBytes } from './completedCapture.js';
import type { GenerationDecision } from './generationDecision.js';
import { generationFolderName, parseCaptureRecord, recordFileName } from './record.js';
import type { CaptureRecord, Snapshot } from './record.js';
import { existingEntry } from './reviewDirectory.js';

interface EarlierCapture {
  target: DirectTarget;
  base: string | null;
  snapshot: Snapshot | undefined;
}

export type PinnedPredecessor =
  | ({ status: 'chained'; review: string; identity: string; endpointTree: string } & EarlierCapture)
  | ({ status: 'legacy' } & EarlierCapture);

const versionOneMessage = (review: string) =>
  `${review} holds a version 1 capture record, which saved no snapshot. Capture the review again, then name that review.`;

const refuseStatus = (review: string, decision: GenerationDecision): never => {
  throw new Error(
    `The capture in ${review} is ${decision.status}, so a fix review cannot compare against it. Nothing was written.\n- ${decision.reasons.join('\n- ')}`,
  );
};

const refuseMissingRecord = async (root: string, review: string): Promise<never> => {
  if ((await existingEntry(join(review, generationFolderName))) === undefined) {
    throw new Error(`${review} holds no capture record, so a fix review has nothing to compare.`);
  }

  return refuseStatus(review, await readCompletedCapture(root, review));
};

const isSnapshotTarget = (target: DirectTarget) =>
  target.kind === 'workingTree' || target.kind === 'files';

const earlierCapture = (review: string, record: CaptureRecord): EarlierCapture => {
  if (record.version === 1) {
    throw new Error(versionOneMessage(review));
  }

  const { target, snapshot, base } = record;

  if (target.kind === 'fix') {
    throw new Error(
      `${review} holds a fix capture, and a fix capture cannot be a predecessor yet.`,
    );
  }

  if (isSnapshotTarget(target) && snapshot === undefined) {
    throw new Error(`${review} holds a capture record with no snapshot.`);
  }

  return { target, base, snapshot };
};

const completeEndpointTree = (record: CaptureRecord) =>
  'endpoint' in record && record.endpoint.status === 'complete' ? record.endpoint.tree : undefined;

// The one owner of what a fix capture may compare against. A full capture whose endpoint is
// complete is chained by its record identity and endpoint tree; an older one keeps the snapshot
// or pinned-commit comparison.
export const pinPredecessor = async (root: string, review: string): Promise<PinnedPredecessor> => {
  const recordPath = join(review, recordFileName);
  const bytes = await readOptionalBytes(recordPath);

  if (bytes === undefined) {
    return refuseMissingRecord(root, review);
  }

  const record = parseCaptureRecord(recordPath, bytes.toString('utf8'));
  const earlier = earlierCapture(review, record);
  const identity = await hashOf(root, bytes);
  const decision = await readCompletedCapture(root, review, identity);

  if (decision.status !== 'completed' && decision.status !== 'legacy') {
    return refuseStatus(review, decision);
  }

  const endpointTree = completeEndpointTree(record);

  if (decision.status === 'legacy' || endpointTree === undefined) {
    return { status: 'legacy', ...earlier };
  }

  return { status: 'chained', review, identity, endpointTree, ...earlier };
};
