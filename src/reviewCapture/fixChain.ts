import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { errorMessage } from '../errors.js';
import { readGit } from '../git.js';
import { captureTarget } from './capture.js';
import type { Capture } from './capture.js';
import { hashOf, readCompletedCapture, readOptionalBytes } from './completedCapture.js';
import type { ChainedTrees, Endpoint, EndpointCapture } from './endpoint.js';
import { decideEndpoint } from './endpointDecision.js';
import { decidePredecessor, statusRefusal } from './predecessorDecision.js';
import { generationFolderName, parseCaptureRecord, recordFileName } from './record.js';
import type { CaptureRecord, Snapshot } from './record.js';
import { existingEntry } from './reviewDirectory.js';
import type { PinnedTarget } from './target.js';

// Every fix capture keeps the predecessor's identity, read once at pinning, so publication can check
// that the same record is still there.
export interface PinnedPredecessor {
  status: 'chained' | 'legacy';
  review: string;
  identity: string;
  endpointTree: string | undefined;
  target: PinnedTarget;
  base: string | null;
  snapshot: Snapshot | undefined;
}

type ChainedFixTarget = Extract<PinnedTarget, { kind: 'fix' }> & {
  predecessor: NonNullable<Extract<PinnedTarget, { kind: 'fix' }>['predecessor']>;
};

// A chained fix capture also returns the trees it compared, so the endpoint holds exactly the
// content the patch shows.
export interface ReviewCapture extends Capture {
  chain?: ChainedTrees;
}

const refuseMissingRecord = async (root: string, review: string): Promise<never> => {
  if ((await existingEntry(join(review, generationFolderName))) === undefined) {
    throw new Error(`${review} holds no capture record, so a fix review has nothing to compare.`);
  }

  throw new Error(statusRefusal(review, await readCompletedCapture(root, review)));
};

const completeEndpointTree = (record: CaptureRecord) =>
  'endpoint' in record && record.endpoint.status === 'complete' ? record.endpoint.tree : undefined;

export const pinPredecessor = async (root: string, review: string): Promise<PinnedPredecessor> => {
  const recordPath = join(review, recordFileName);
  const bytes = await readOptionalBytes(recordPath);

  if (bytes === undefined) {
    return refuseMissingRecord(root, review);
  }

  const record = parseCaptureRecord(recordPath, bytes.toString('utf8'));
  const identity = await hashOf(root, bytes);
  const snapshot = 'snapshot' in record ? record.snapshot : undefined;

  const decision = decidePredecessor({
    review,
    version: record.version,
    target: record.target.kind,
    hasSnapshot: snapshot !== undefined,
    generation: await readCompletedCapture(root, review, identity),
    endpointTree: completeEndpointTree(record),
  });

  if (decision.status === 'refused') {
    throw new Error(decision.reason);
  }

  const endpointTree = decision.status === 'chained' ? decision.endpointTree : undefined;
  const { target, base } = record;

  return { status: decision.status, review, identity, endpointTree, target, base, snapshot };
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
