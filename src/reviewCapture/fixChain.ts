import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { errorMessage } from '../errors.js';
import { readGit, runGit } from '../git.js';
import { captureTarget, uniqueGaps } from './capture.js';
import type { Capture } from './capture.js';
import { hashOf, readCompletedCapture, readOptionalBytes } from './completedCapture.js';
import type { ChainedTrees, Endpoint, EndpointCapture } from './endpoint.js';
import { decideEndpoint } from './endpointDecision.js';
import { decidePredecessor, statusRefusal } from './predecessorDecision.js';
import { generationFolderName, parseCaptureRecord, recordFileName } from './record.js';
import type { CaptureRecord, Snapshot } from './record.js';
import { existingEntry } from './reviewDirectory.js';
import type { PinnedTarget } from './target.js';

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

export interface ReviewCapture extends Capture {
  chain?: ChainedTrees;
}

interface WorkingTree {
  tree: string;
  dirtySubmodules: string[];
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

const statusPathStart: Record<string, number | undefined> = { '1': 8, '2': 9, u: 10 };

// A submodule whose checked-out commit is unchanged but whose files are not: `git status` marks it
// with `S.M.` or `S..U`. Each record is `<type> <XY> <sub> ...`; a rename record has one more path.
const dirtySubmodules = (status: string): string[] => {
  const fields = status.split('\0');
  const paths: string[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? '';
    const parts = field.split(' ');
    const pathStart = statusPathStart[parts[0] ?? ''];
    const submodule = parts[2] ?? '';

    if (pathStart !== undefined && /^S.(M.|.U)$/.test(submodule)) {
      paths.push(parts.slice(pathStart).join(' '));
    }

    if (parts[0] === '2') {
      index += 1;
    }
  }

  return paths;
};

// The tree `git add -A && git commit` would write, built in a temporary index that starts from the
// entries of the user's index, so a tracked file stays even when .gitignore matches it. The
// user's index is never written. Excluded paths keep their staged content.
const writeWorkingTree = async (root: string, exclude: readonly string[]): Promise<WorkingTree> => {
  const folder = await mkdtemp(join(tmpdir(), 'tau-fix-chain-'));
  const environment = { GIT_INDEX_FILE: join(folder, 'index') };
  const spec = ['--', '.', ...exclude.map((path) => `:(exclude)${path}`)];

  try {
    const staged = await runGit(root, ['--no-optional-locks', 'ls-files', '-s', '-z']);

    if (staged.exitCode !== 0) {
      throw new Error(`git ls-files -s failed: ${staged.stderr.trim()}`);
    }

    const entries = staged.stdout.toString('utf8');

    await readGit(root, ['update-index', '-z', '--index-info'], { environment, input: entries });
    await readGit(root, ['add', '-A', ...spec], { environment });

    const tree = await readGit(root, ['write-tree'], { environment });

    const status = await runGit(
      root,
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=no',
        '--ignore-submodules=none',
        ...spec,
      ],
      { environment },
    );

    if (status.exitCode !== 0) {
      throw new Error(`git status failed: ${status.stderr.trim()}`);
    }

    return { tree, dirtySubmodules: dirtySubmodules(status.stdout.toString('utf8')) };
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

export const captureChainedFix = async (
  root: string,
  fix: ChainedFixTarget,
): Promise<ReviewCapture> => {
  if (fix.base === null) {
    return failedCapture(`The fix capture of ${fix.review} names no base commit.`);
  }

  try {
    const exclude = fix.exclude ?? [];
    const { tree, dirtySubmodules: dirty } = await writeWorkingTree(root, exclude);
    const baseTree = fix.predecessor.endpointTree;

    const captured = await captureTarget(root, {
      kind: 'range',
      from: baseTree,
      to: tree,
      exclude,
    });

    const { addedBytes: _addedBytes, ...patch } = captured;
    const submoduleGaps = dirty.map((path) => ({ kind: 'submodule' as const, path }));
    const gaps = uniqueGaps([...captured.gaps, ...submoduleGaps]);
    const changed = [...new Set([...captured.paths, ...dirty])].toSorted();

    return { ...patch, gaps, changed, chain: { baseTree, tree } };
  } catch (error) {
    return failedCapture(errorMessage(error));
  }
};

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
