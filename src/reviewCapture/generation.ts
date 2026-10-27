import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, hasErrorCode, isMissingFile } from '../errors.js';
import { publishTextSync } from '../record.js';
import { rejectLinkedFile } from '../tauDirectory.js';
import { hashBytes, pinTarget, readHead } from './capture.js';
import type { Capture, Gap } from './capture.js';
import { pinFixTarget, saveVerifiedSnapshot, snapshotFolder } from './fixCapture.js';
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
  // The Git blob hash of capture.json. An empty capture writes no record, so it has none.
  identity?: string;
}

// What a failed capture must undo. It grows as each step changes the review directory.
interface Owned {
  snapshot: boolean;
  // The capture.json text this capture tried to publish.
  recordText: string | undefined;
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

// An artifact that cannot be read counts as missing, so the decision names it as missing.
const readArtifactBytes = async (path: string): Promise<Buffer | undefined> => {
  await rejectLinkedFile(path, 'read');

  return readFile(path).catch(() => undefined);
};

const hashArtifact = async (root: string, bytes: Buffer | undefined) =>
  bytes === undefined ? undefined : hashOf(root, bytes);

const savedRecord = async (root: string, path: string, bytes: Buffer): Promise<SavedRecord> => {
  const record = parseCaptureRecord(path, bytes.toString('utf8'));
  const recorded = 'original' in record ? record.original : undefined;

  return { version: record.version, identity: await hashOf(root, bytes), recorded };
};

// Reads a saved generation without changing it. The identity is the Git blob hash of capture.json.
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
    recordBytes === undefined ? undefined : await savedRecord(root, recordPath, recordBytes);

  const patchBytes = await readArtifactBytes(join(folder, generationPatchFileName));
  const inputBytes = await readArtifactBytes(join(folder, generationInputFileName));

  const observed = {
    patch: await hashArtifact(root, patchBytes),
    input: await hashArtifact(root, inputBytes),
  };

  return decideGeneration({ record, observed, expectedIdentity });
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

// The non-recursive mkdir is the claim: only one capture can create the folder.
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

// Removes capture.json only when it holds the text this capture published.
const removeOwnRecord = async (path: string, text: string | undefined) => {
  if (text === undefined) {
    return;
  }

  const saved = await readFile(path, 'utf8').catch(() => undefined);

  if (saved === text) {
    await rm(path, { force: true });
  }
};

// Each cleanup runs even when another fails. Returns one line per failed cleanup, so the caller can
// report them next to the capture error.
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

  const record: CaptureRecord = {
    version: 3,
    target: pinned,
    base,
    head,
    hash: captured.hash,
    ...(snapshot === undefined ? {} : { snapshot }),
    gaps: captured.gaps,
    original: { patch: await hashOf(root, captured.bytes), input: await hashOf(root, input) },
  };

  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  const identity = await hashOf(root, Buffer.from(recordText));

  owned.recordText = recordText;
  publishTextSync(join(directory, recordFileName), recordText, { mode: recordMode });

  return { ...summary, empty: false, identity };
};

// Publishes a complete generation or nothing. The capture that claims the directory saves the
// original patch and input, checks the saved bytes, and writes capture.json last. Only that capture
// rolls back; a capture whose claim was refused changes nothing.
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
