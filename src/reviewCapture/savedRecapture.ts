import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { hashOf, readOptionalBytes } from './completedCapture.js';
import { readCaptureRecord, recheckFileName } from './record.js';
import { checkReviewDirectory } from './reviewDirectory.js';

export interface SavedRecapture {
  directory: string;
  recordedBase: string | null;
  recordedHash: string;
  recheck: Buffer;
  recheckHash: string;
}

export type RecheckRead =
  | { status: 'read'; bytes: Buffer; hash: string }
  | { status: 'error'; error: string };

const missingCause = (path: string): Promise<unknown> =>
  lstat(path).then(
    () => undefined,
    (error: unknown) => error,
  );

export const readRecheck = async (
  root: string,
  directory: string,
): Promise<{ bytes: Buffer; hash: string }> => {
  const path = join(directory, recheckFileName);
  const bytes = await readOptionalBytes(path);

  if (bytes === undefined) {
    throw new Error(`No recheck.diff at ${path}. Run code_review freshness first.`, {
      cause: await missingCause(path),
    });
  }

  return { bytes, hash: await hashOf(root, bytes) };
};

export const readSavedRecapture = async (
  root: string,
  directory: string,
): Promise<SavedRecapture> => {
  const checked = await checkReviewDirectory(root, directory);
  const record = await readCaptureRecord(checked);
  const { bytes, hash } = await readRecheck(root, checked);

  return {
    directory: checked,
    recordedBase: record.base,
    recordedHash: record.hash,
    recheck: bytes,
    recheckHash: hash,
  };
};
