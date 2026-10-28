import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, hasErrorCode } from '../errors.js';
import { publishTextSync } from '../record.js';
import { pinTarget, readHead } from './capture.js';
import type { Capture, Gap } from './capture.js';
import { hashOf, hashSnapshot, readCompletedCapture } from './completedCapture.js';
import { publishEndpoint, releaseEndpoint } from './endpointRetention.js';
import type { RetainedEndpoint } from './endpointRetention.js';
import { pinFixTarget, saveVerifiedSnapshot } from './fixCapture.js';
import { decideFixScope } from './fixScope.js';
import type { FixScope } from './fixScope.js';
import { captureReview } from './pinnedCapture.js';
import {
  generationFolderName,
  generationInputFileName,
  generationPatchFileName,
  inputFileName,
  recordFileName,
  snapshotFolder,
} from './record.js';
import type { CaptureRecord } from './record.js';
import { existingEntry } from './reviewDirectory.js';
import type { PinnedTarget, ReviewTarget } from './target.js';

export interface CapturedGeneration extends Partial<FixScope> {
  hash: string;
  head: string;
  base: string | null;
  paths: string[];
  gaps: Gap[];
  fixPaths?: string[];
  empty: boolean;
  identity?: string;
}

interface Owned {
  snapshot: boolean;
  endpoint: RetainedEndpoint | undefined;
  recordText: string | undefined;
}

const captureHeading = '## Capture';

const lastHeading = (text: string) =>
  text
    .split('\n')
    .findLast((line) => line.startsWith('#'))
    ?.trim();

const readInput = async (directory: string) => {
  const path = join(directory, inputFileName);
  const bytes = await readFile(path);

  if (lastHeading(bytes.toString('utf8')) !== captureHeading) {
    throw new Error(`${path} must end with a "${captureHeading}" heading. Nothing was written.`);
  }

  return bytes;
};

const rejectSavedCapture = async (directory: string) => {
  const path = join(directory, recordFileName);

  if ((await existingEntry(path)) !== undefined) {
    throw new Error(`${path} already holds a capture. Run prepare for a new review.`);
  }
};

const claimDirectory = async (folder: string) => {
  try {
    await mkdir(folder);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }

    throw new Error(
      `${folder} already exists. Another capture owns this review directory, or an earlier capture failed partway. Run prepare for a new review.`,
      { cause: error },
    );
  }
};

const gapLabels: Record<Gap['kind'], string> = {
  binary: 'binary file, not shown',
  unreadable: 'unreadable file or directory, not shown',
  excluded: 'excluded from the review',
  unmatched: 'named path that lists no file',
  submodule: 'submodule or nested repository, contents not shown',
};

// JSON keeps a path with a newline on one line, and an escaped backtick cannot end the code span.
const quotePath = (path: string) => JSON.stringify(path).replaceAll('`', String.raw`\u0060`);

const gapsSection = (gaps: Gap[]) => {
  const lines = gaps.map((gap) => `- \`${quotePath(gap.path)}\`: ${gapLabels[gap.kind]}`);
  const body = lines.length === 0 ? 'None.' : lines.join('\n');

  return `\n## Gaps\n\n${body}\n`;
};

const newline = Buffer.from('\n');

const withFinalNewline = (bytes: Buffer) =>
  bytes.subarray(-1).equals(newline) ? bytes : Buffer.concat([bytes, newline]);

const appendedInput = (input: Buffer, captured: Capture) => {
  const separator = input.subarray(-1).equals(newline) ? '\n' : '\n\n';

  return Buffer.concat([
    Buffer.from(separator),
    withFinalNewline(captured.bytes),
    Buffer.from(gapsSection(captured.gaps)),
  ]);
};

const baseOf = (target: PinnedTarget) => {
  if (target.kind === 'range') {
    return target.from;
  }

  if (target.kind === 'rootCommit') {
    return null;
  }

  return target.base;
};

const pin = (root: string, target: ReviewTarget) =>
  target.kind === 'fix' ? pinFixTarget(root, target) : pinTarget(root, target);

// The predecessor's capture.json may be replaced while the fix capture runs, so it is read again
// right before the fix record that names it is published.
const recheckPredecessor = async (root: string, target: PinnedTarget) => {
  const predecessor = target.kind === 'fix' ? target.predecessor : undefined;

  if (predecessor === undefined) {
    return;
  }

  const decision = await readCompletedCapture(root, predecessor.review, predecessor.identity);

  if (decision.status !== 'completed') {
    throw new Error(
      `The capture in ${predecessor.review} became ${decision.status} during the fix capture. Nothing was written.\n- ${decision.reasons.join('\n- ')}`,
    );
  }
};

const hasSnapshot = (
  target: PinnedTarget,
): target is Extract<PinnedTarget, { kind: 'workingTree' | 'files' }> =>
  target.kind === 'workingTree' || target.kind === 'files';

const fixSummary = (target: PinnedTarget, paths: string[]) => {
  if (target.kind !== 'fix') {
    return {};
  }

  const { scope, outsidePaths } = decideFixScope({
    fixPaths: paths,
    findingPaths: target.findingPaths,
  });

  return { fixPaths: paths, scope, outsidePaths };
};

const captureTarget = async (root: string, target: ReviewTarget) => {
  const pinned = await pin(root, target);
  const captured = await captureReview(root, pinned);

  if (captured.errors.length > 0) {
    throw new Error(`The capture failed. Nothing was written.\n- ${captured.errors.join('\n- ')}`);
  }

  const { head, error: headError } = await readHead(root);

  if (head === undefined) {
    throw new Error(`${headError} Nothing was written.`);
  }

  return { pinned, captured, head };
};

const saveArtifacts = async (folder: string, patch: Buffer, input: Buffer) => {
  await writeFile(join(folder, generationPatchFileName), patch, { flag: 'wx' });
  await writeFile(join(folder, generationInputFileName), input, { flag: 'wx' });
};

const verifyArtifact = async (path: string, written: Buffer) => {
  const saved = await readFile(path);

  if (!saved.equals(written)) {
    throw new Error(`${path} does not hold the bytes the capture wrote.`);
  }
};

const verifyArtifacts = async (folder: string, patch: Buffer, input: Buffer) => {
  await verifyArtifact(join(folder, generationPatchFileName), patch);
  await verifyArtifact(join(folder, generationInputFileName), input);
};

const removeOwnRecord = async (path: string, text: string | undefined) => {
  if (text === undefined) {
    return;
  }

  const saved = await readFile(path, 'utf8').catch(() => undefined);

  if (saved === text) {
    await rm(path, { force: true });
  }
};

const rollback = async (
  root: string,
  directory: string,
  originalInput: Buffer,
  owned: Owned,
): Promise<string[]> => {
  const removeSnapshot = owned.snapshot
    ? rm(join(directory, snapshotFolder), { recursive: true, force: true })
    : Promise.resolve();

  const removeEndpoint =
    owned.endpoint === undefined ? Promise.resolve() : releaseEndpoint(root, owned.endpoint);

  const results = await Promise.allSettled([
    writeFile(join(directory, inputFileName), originalInput),
    removeSnapshot,
    rm(join(directory, generationFolderName), { recursive: true, force: true }),
    removeOwnRecord(join(directory, recordFileName), owned.recordText),
    removeEndpoint,
  ]);

  const steps = [
    'restoring input.md',
    'removing the snapshot',
    'removing the capture folder',
    `removing ${recordFileName}`,
    'deleting the endpoint ref',
  ];

  return results.flatMap((result, index) =>
    result.status === 'rejected' ? [`${steps[index]}: ${errorMessage(result.reason)}`] : [],
  );
};

const rollbackError = (error: unknown, failedCleanups: string[]) =>
  new Error(
    `${errorMessage(error)}\nThe rollback also failed (${failedCleanups.join('; ')}). The review directory may be half-written. Prepare a new review.`,
    { cause: error },
  );

const recordMode = 0o644;

const publishGeneration = async (
  root: string,
  directory: string,
  target: ReviewTarget,
  originalInput: Buffer,
  owned: Owned,
): Promise<CapturedGeneration> => {
  const folder = join(directory, generationFolderName);
  const { pinned, captured, head } = await captureTarget(root, target);
  const base = baseOf(pinned);

  const summary = {
    hash: captured.hash,
    head,
    base,
    paths: captured.paths,
    gaps: captured.gaps,
    ...fixSummary(pinned, captured.changed ?? captured.paths),
  };

  if (captured.bytes.length === 0) {
    await rm(folder, { recursive: true });

    return { ...summary, empty: true };
  }

  const appended = appendedInput(originalInput, captured);
  const input = Buffer.concat([originalInput, appended]);

  const snapshot = hasSnapshot(pinned)
    ? await saveVerifiedSnapshot(directory, root, pinned, captured)
    : undefined;

  owned.snapshot = snapshot !== undefined;

  await saveArtifacts(folder, captured.bytes, input);
  await appendFile(join(directory, inputFileName), appended);
  await verifyArtifacts(folder, captured.bytes, input);

  const snapshotHash = await hashSnapshot(root, directory, snapshot);

  if (snapshot !== undefined && snapshotHash === undefined) {
    throw new Error(`A saved copy in ${join(directory, snapshotFolder)} could not be read.`);
  }

  const { endpoint, retained } = await publishEndpoint(root, {
    directory,
    target: pinned,
    gaps: captured.gaps,
    patch: captured.bytes,
    snapshot,
    chain: captured.chain,
  });

  owned.endpoint = retained;

  const record: CaptureRecord = {
    version: 5,
    target: pinned,
    base,
    head,
    hash: captured.hash,
    ...(snapshot === undefined ? {} : { snapshot }),
    gaps: captured.gaps,
    original: {
      patch: await hashOf(root, captured.bytes),
      input: await hashOf(root, input),
      ...(snapshotHash === undefined ? {} : { snapshot: snapshotHash }),
    },
    endpoint,
  };

  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  const identity = await hashOf(root, Buffer.from(recordText));

  await recheckPredecessor(root, pinned);

  owned.recordText = recordText;
  publishTextSync(join(directory, recordFileName), recordText, { mode: recordMode });

  return { ...summary, empty: false, identity };
};

export const captureGeneration = async (
  root: string,
  directory: string,
  target: ReviewTarget,
): Promise<CapturedGeneration> => {
  await rejectSavedCapture(directory);

  const originalInput = await readInput(directory);

  await claimDirectory(join(directory, generationFolderName));

  const owned: Owned = { snapshot: false, endpoint: undefined, recordText: undefined };

  try {
    return await publishGeneration(root, directory, target, originalInput, owned);
  } catch (error) {
    const failedCleanups = await rollback(root, directory, originalInput, owned);

    if (failedCleanups.length > 0) {
      throw rollbackError(error, failedCleanups);
    }

    throw error;
  }
};
