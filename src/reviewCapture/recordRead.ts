import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { hashOf, readOptionalBytes } from './completedCapture.js';
import { parseCaptureRecord, recordFileName } from './record.js';
import type { CaptureRecord } from './record.js';

export type RecordRead =
  | { status: 'missing'; path: string; cause: unknown }
  | { status: 'unreadable'; path: string; error: unknown }
  | { status: 'read'; path: string; bytes: Buffer; record: CaptureRecord; identity: string };

export const missingCause = (path: string): Promise<unknown> =>
  lstat(path).then(
    () => undefined,
    (error: unknown) => error,
  );

// Refuses a linked record before any read, so a link cannot send the read outside the checkout.
export const readRecord = async (root: string, directory: string): Promise<RecordRead> => {
  const path = join(directory, recordFileName);
  const bytes = await readOptionalBytes(path);

  if (bytes === undefined) {
    return { status: 'missing', path, cause: await missingCause(path) };
  }

  let record: CaptureRecord;

  try {
    record = parseCaptureRecord(path, bytes.toString('utf8'));
  } catch (error) {
    return { status: 'unreadable', path, error };
  }

  return { status: 'read', path, bytes, record, identity: await hashOf(root, bytes) };
};

export const recordError = (result: Exclude<RecordRead, { status: 'read' }>): unknown =>
  result.status === 'missing'
    ? new Error(`No capture record at ${result.path}. Run capture first.`, { cause: result.cause })
    : result.error;

export const requireRecord = (result: RecordRead): Extract<RecordRead, { status: 'read' }> => {
  if (result.status !== 'read') {
    throw recordError(result);
  }

  return result;
};
