import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { errorMessage } from '../errors.js';
import { readGit } from '../git.js';
import { captureTarget } from './capture.js';
import type { Capture, DirectTarget } from './capture.js';
import { hashOf, readCompletedCapture, readOptionalBytes } from './completedCapture.js';
import type { ChainedTrees, Endpoint, EndpointCapture } from './endpoint.js';
import { decideEndpoint } from './endpointDecision.js';
import type { GenerationDecision } from './generationDecision.js';
import { generationFolderName, parseCaptureRecord, recordFileName } from './record.js';
import type { CaptureRecord, Snapshot } from './record.js';
import { existingEntry } from './reviewDirectory.js';
import type { PinnedTarget } from './target.js';

interface EarlierCapture<Target extends PinnedTarget> {
  target: Target;
  base: string | null;
  snapshot: Snapshot | undefined;
}

export type PinnedPredecessor =
  | ({
      status: 'chained';
      review: string;
      identity: string;
      endpointTree: string;
    } & EarlierCapture<PinnedTarget>)
  | ({ status: 'legacy' } & EarlierCapture<DirectTarget>);

type ChainedFixTarget = Extract<PinnedTarget, { kind: 'fix' }> & {
  predecessor: NonNullable<Extract<PinnedTarget, { kind: 'fix' }>['predecessor']>;
};

// A chained fix capture also returns the trees it compared, so the endpoint holds exactly the
// content the patch shows.
export interface ReviewCapture extends Capture {
  chain?: ChainedTrees;
}

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

const isSnapshotTarget = (target: PinnedTarget) =>
  target.kind === 'workingTree' || target.kind === 'files';

const earlierCapture = (review: string, record: CaptureRecord): EarlierCapture<PinnedTarget> => {
  if (record.version === 1) {
    throw new Error(versionOneMessage(review));
  }

  const { target, snapshot, base } = record;

  if (isSnapshotTarget(target) && snapshot === undefined) {
    throw new Error(`${review} holds a capture record with no snapshot.`);
  }

  return { target, base, snapshot };
};

const legacyCapture = (
  review: string,
  earlier: EarlierCapture<PinnedTarget>,
): EarlierCapture<DirectTarget> => {
  const { target } = earlier;

  if (target.kind === 'fix') {
    throw new Error(
      `${review} holds a fix capture with no complete endpoint, so a fix capture cannot compare against it.`,
    );
  }

  return { ...earlier, target };
};

const completeEndpointTree = (record: CaptureRecord) =>
  'endpoint' in record && record.endpoint.status === 'complete' ? record.endpoint.tree : undefined;

// The one owner of what a fix capture may compare against. A full or fix capture whose endpoint is
// complete is chained by its record identity and endpoint tree; an older full capture keeps the
// snapshot or pinned-commit comparison.
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
    return { status: 'legacy', ...legacyCapture(review, earlier) };
  }

  return { status: 'chained', review, identity, endpointTree, ...earlier };
};

// The tree of the working tree, written through a temporary index that starts from the chain
// base, so the user's index is never read or written. Excluded paths keep their base content.
const writeWorkingTree = async (root: string, base: string, exclude: readonly string[]) => {
  const folder = await mkdtemp(join(tmpdir(), 'tau-fix-chain-'));
  const environment = { GIT_INDEX_FILE: join(folder, 'index') };
  const excluded = exclude.map((path) => `:(exclude)${path}`);

  try {
    await readGit(root, ['read-tree', base], { environment });
    await readGit(root, ['add', '-A', '--', '.', ...excluded], { environment });

    return await readGit(root, ['write-tree'], { environment });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

const failedCapture = (message: string): ReviewCapture => ({
  bytes: Buffer.alloc(0),
  hash: '',
  paths: [],
  gaps: [],
  errors: [message],
});

// The diff from the predecessor's endpoint tree to the working tree. The patch is made from the
// tree written once, so the returned trees hold the content the patch shows.
export const captureChainedFix = async (
  root: string,
  fix: ChainedFixTarget,
): Promise<ReviewCapture> => {
  if (fix.base === null) {
    return failedCapture(`The fix capture of ${fix.review} names no base commit.`);
  }

  try {
    const exclude = fix.exclude ?? [];
    const tree = await writeWorkingTree(root, fix.base, exclude);
    const baseTree = fix.predecessor.endpointTree;

    const captured = await captureTarget(root, {
      kind: 'range',
      from: baseTree,
      to: tree,
      exclude,
    });

    const { addedBytes: _addedBytes, ...patch } = captured;

    return { ...patch, changed: captured.paths, chain: { baseTree, tree } };
  } catch (error) {
    return failedCapture(errorMessage(error));
  }
};

// The endpoint of a chained fix capture. Undefined for any other capture.
export const buildChainedEndpoint = ({ gaps, chain }: EndpointCapture): Endpoint | undefined => {
  if (chain === undefined) {
    return undefined;
  }

  const eligibility = decideEndpoint({
    target: 'fix',
    chainedFix: true,
    gaps,
    snapshot: undefined,
  });

  if (eligibility.status !== 'eligible') {
    return eligibility;
  }

  return { status: 'complete', ...chain };
};
