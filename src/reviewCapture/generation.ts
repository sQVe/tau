import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, hasErrorCode, isMissingFile } from '../errors.js';
import { publishTextSync } from '../record.js';
import { rejectLinkedFile } from '../tauDirectory.js';
import { hashBytes, pinTarget, readHead } from './capture.js';
import type { Capture, Gap } from './capture.js';
import { pinFixTarget, saveVerifiedSnapshot, snapshotFolder } from './fixCapture.js';
import type { FixReviewTarget } from './fixCapture.js';
import { decideFixScope } from './fixScope.js';
import type { FixScope } from './fixScope.js';
import { decideGeneration } from './generationDecision.js';
import type { GenerationDecision, SavedRecord } from './generationDecision.js';
import { captureReview } from './pinnedCapture.js';
import {
  generationFolderName,
  generationInputFileName,
  generationPatchFileName,
  inputFileName,
  parseCaptureRecord,
  recordFileName,
} from './record.js';
import type { CaptureRecord, Snapshot } from './record.js';
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
  recordText: string | undefined;
}

interface ReadRecord {
  saved: SavedRecord;
  snapshot: Snapshot | undefined;
}

const hashOf = async (root: string, bytes: Buffer): Promise<string> => {
  const hashed = await hashBytes(root, bytes);

  if (hashed.error !== undefined) {
    throw new Error(hashed.error);
  }

  return hashed.hash;
};

const readOptionalBytes = async (path: string): Promise<Buffer | undefined> => {
  await rejectLinkedFile(path, 'read');

  try {
    return await readFile(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const readArtifactBytes = async (path: string): Promise<Buffer | undefined> => {
  await rejectLinkedFile(path, 'read');

  return readFile(path).catch(() => undefined);
};

const hashArtifact = async (root: string, bytes: Buffer | undefined) =>
  bytes === undefined ? undefined : hashOf(root, bytes);

const ownerExecutableBit = 0o100;

// Git's no-index diff reads only the owner's executable bit, so a fix capture sees no other mode.
const copyMode = async (path: string) => {
  const { mode } = await stat(path);

  return (mode & ownerExecutableBit) === 0 ? '100644' : '100755';
};

const copyLine = async (root: string, folder: string, path: string) => {
  const file = join(folder, path);
  const hash = await hashArtifact(root, await readArtifactBytes(file));

  if (hash === undefined) {
    return undefined;
  }

  return `${await copyMode(file)} ${hash} ${JSON.stringify(path)}`;
};

const snapshotManifest = async (
  root: string,
  directory: string,
  snapshot: Snapshot,
): Promise<Buffer | undefined> => {
  const folder = join(directory, snapshotFolder);

  const copyLines = await Promise.all(
    snapshot.present.toSorted().map((path) => copyLine(root, folder, path)),
  );

  if (copyLines.includes(undefined)) {
    return undefined;
  }

  const lines = [
    ...copyLines,
    `absent ${JSON.stringify(snapshot.absent)}`,
    `skipped ${JSON.stringify(snapshot.skipped)}`,
  ];

  return Buffer.from(`${lines.join('\n')}\n`);
};

const hashSnapshot = async (root: string, directory: string, snapshot: Snapshot | undefined) =>
  snapshot === undefined
    ? undefined
    : hashArtifact(root, await snapshotManifest(root, directory, snapshot));

const readSavedRecord = async (root: string, path: string, bytes: Buffer): Promise<ReadRecord> => {
  const record = parseCaptureRecord(path, bytes.toString('utf8'));
  const recorded = 'original' in record ? record.original : undefined;
  const snapshot = 'snapshot' in record ? record.snapshot : undefined;

  return {
    saved: { version: record.version, identity: await hashOf(root, bytes), recorded },
    snapshot,
  };
};

export const readCompletedCapture = async (
  root: string,
  directory: string,
  expectedIdentity?: string,
): Promise<GenerationDecision> => {
  const recordPath = join(directory, recordFileName);
  const folder = join(directory, generationFolderName);

  await rejectLinkedFile(folder, 'read');

  const recordBytes = await readOptionalBytes(recordPath);
  const folderExists = (await existingEntry(folder)) !== undefined;

  if (recordBytes === undefined && !folderExists) {
    throw new Error(`No capture record at ${recordPath}. Run capture first.`);
  }

  const record =
    recordBytes === undefined ? undefined : await readSavedRecord(root, recordPath, recordBytes);

  const patchBytes = await readArtifactBytes(join(folder, generationPatchFileName));
  const inputBytes = await readArtifactBytes(join(folder, generationInputFileName));

  const observed = {
    patch: await hashArtifact(root, patchBytes),
    input: await hashArtifact(root, inputBytes),
    snapshot: await hashSnapshot(root, directory, record?.snapshot),
  };

  return decideGeneration({ record: record?.saved, observed, expectedIdentity });
};

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

const rejectChangedReview = async (root: string, review: string) => {
  const decision = await readCompletedCapture(root, review);

  if (decision.status === 'completed' || decision.status === 'legacy') {
    return;
  }

  throw new Error(
    `The capture in ${review} is ${decision.status}, so a fix review cannot compare against it. Nothing was written.\n- ${decision.reasons.join('\n- ')}`,
  );
};

const pinFix = async (root: string, target: FixReviewTarget) => {
  const pinned = await pinFixTarget(root, target);

  await rejectChangedReview(root, pinned.review);

  return pinned;
};

const pin = (root: string, target: ReviewTarget) =>
  target.kind === 'fix' ? pinFix(root, target) : pinTarget(root, target);

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
  directory: string,
  originalInput: Buffer,
  owned: Owned,
): Promise<string[]> => {
  const removeSnapshot = owned.snapshot
    ? rm(join(directory, snapshotFolder), { recursive: true, force: true })
    : Promise.resolve();

  const results = await Promise.allSettled([
    writeFile(join(directory, inputFileName), originalInput),
    removeSnapshot,
    rm(join(directory, generationFolderName), { recursive: true, force: true }),
    removeOwnRecord(join(directory, recordFileName), owned.recordText),
  ]);

  const steps = [
    'restoring input.md',
    'removing the snapshot',
    'removing the capture folder',
    `removing ${recordFileName}`,
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

  const record: CaptureRecord = {
    version: 3,
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
  };

  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  const identity = await hashOf(root, Buffer.from(recordText));

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

  const owned: Owned = { snapshot: false, recordText: undefined };

  try {
    return await publishGeneration(root, directory, target, originalInput, owned);
  } catch (error) {
    const failedCleanups = await rollback(directory, originalInput, owned);

    if (failedCleanups.length > 0) {
      throw rollbackError(error, failedCleanups);
    }

    throw error;
  }
};
