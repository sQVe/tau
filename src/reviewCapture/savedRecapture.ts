import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from '../errors.js';
import { hashBytes } from './capture.js';
import { readCaptureRecord, recheckFileName } from './record.js';
import { checkReviewDirectory } from './reviewDirectory.js';

export interface SavedRecapture {
  directory: string;
  recordedBase: string | null;
  recordedHash: string;
  recheck: Buffer;
  recheckHash: string;
}

const readRecheck = async (path: string) => {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`No recheck.diff at ${path}. Run code_review freshness first.`, {
        cause: error,
      });
    }

    throw error;
  }
};

// Reads the recapture that freshness saved. It never recaptures or repairs a missing file.
export const readSavedRecapture = async (
  root: string,
  directory: string,
): Promise<SavedRecapture> => {
  const checked = await checkReviewDirectory(root, directory);
  const record = await readCaptureRecord(checked);
  const recheck = await readRecheck(join(checked, recheckFileName));
  const hashed = await hashBytes(root, recheck);

  if (hashed.error !== undefined) {
    throw new Error(hashed.error);
  }

  return {
    directory: checked,
    recordedBase: record.base,
    recordedHash: record.hash,
    recheck,
    recheckHash: hashed.hash,
  };
};
