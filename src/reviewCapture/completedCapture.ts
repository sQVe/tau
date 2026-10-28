import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from '../errors.js';
import { rejectLinkedFile } from '../tauDirectory.js';
import { hashBytes } from './capture.js';
import { observeSavedEndpoint } from './endpoint.js';
import { decideGeneration } from './generationDecision.js';
import type { GenerationDecision, SavedRecord } from './generationDecision.js';
import {
  generationFolderName,
  generationInputFileName,
  generationPatchFileName,
  parseCaptureRecord,
  isRepositoryPath,
  recordFileName,
  snapshotFolder,
} from './record.js';
import type { RecordedEndpoint, Snapshot } from './record.js';
import { existingEntry } from './reviewDirectory.js';
import type { PinnedTarget } from './target.js';

interface ReadRecord {
  saved: SavedRecord;
  target: PinnedTarget;
  snapshot: Snapshot | undefined;
  endpoint: RecordedEndpoint | undefined;
}

export const hashOf = async (root: string, bytes: Buffer): Promise<string> => {
  const hashed = await hashBytes(root, bytes);

  if (hashed.error !== undefined) {
    throw new Error(hashed.error);
  }

  return hashed.hash;
};

export const readOptionalBytes = async (path: string): Promise<Buffer | undefined> => {
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

  const mode = await copyMode(file).catch(() => undefined);

  return mode === undefined ? undefined : `${mode} ${hash} ${JSON.stringify(path)}`;
};

const snapshotManifest = async (
  root: string,
  directory: string,
  snapshot: Snapshot,
): Promise<Buffer | undefined> => {
  const folder = join(directory, snapshotFolder);
  const unsafe = snapshot.present.find((path) => !isRepositoryPath(path));

  if (unsafe !== undefined) {
    throw new Error(`The snapshot of ${directory} names a path outside the repository: ${unsafe}`);
  }

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

export const hashSnapshot = async (
  root: string,
  directory: string,
  snapshot: Snapshot | undefined,
): Promise<string | undefined> =>
  snapshot === undefined
    ? undefined
    : hashArtifact(root, await snapshotManifest(root, directory, snapshot));

const readSavedRecord = async (root: string, path: string, bytes: Buffer): Promise<ReadRecord> => {
  const record = parseCaptureRecord(path, bytes.toString('utf8'));
  const recorded = 'original' in record ? record.original : undefined;
  const snapshot = 'snapshot' in record ? record.snapshot : undefined;
  const endpoint = 'endpoint' in record ? record.endpoint : undefined;

  return {
    saved: { version: record.version, identity: await hashOf(root, bytes), recorded },
    target: record.target,
    snapshot,
    endpoint,
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

  const originalPatch = observed.patch === record?.saved.recorded?.patch ? patchBytes : undefined;
  const endpoint = await observeSavedEndpoint(root, record, originalPatch);

  return decideGeneration({ record: record?.saved, observed, endpoint, expectedIdentity });
};
