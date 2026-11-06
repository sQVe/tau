import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage, isMissingFile } from '../errors.js';
import { parseVersionedRecord, publishRecord, PublishError, readBoundedText } from '../record.js';
import { isUuid, requestByteLimit, uuidSchema } from './protocol.js';

export type HandoverRecord = Static<typeof recordSchema>;

export type HandoverRead =
  | { kind: 'record'; record: HandoverRecord }
  | { kind: 'missing' }
  | { kind: 'malformed'; reason: string };

// `changed`: a record with this message ID holds other text.
export type PublishOutcome = 'published' | 'existing' | 'changed';

const recordVersion = 1;

const recordSchema = Type.Object(
  {
    version: Type.Literal(recordVersion),
    messageId: uuidSchema,
    targetTerminal: Type.String({ minLength: 1 }),
    targetSessionId: uuidSchema,
    text: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const recordOptions = { label: 'handover record', version: recordVersion, schema: recordSchema };

// The record holds the request's text with JSON escapes and a few small fields, so twice the frame
// limit bounds every record a valid request can produce.
const recordByteLimit = 2 * requestByteLimit;

const recordPath = (directory: string, messageId: string): string =>
  join(directory, `${messageId}.json`);

export const readHandover = async (directory: string, messageId: string): Promise<HandoverRead> => {
  const path = recordPath(directory, messageId);

  try {
    const text = await readBoundedText(path, recordByteLimit, 'Handover record');

    return { kind: 'record', record: parseVersionedRecord(path, text, recordOptions) };
  } catch (error) {
    if (isMissingFile(error)) {
      return { kind: 'missing' };
    }

    return { kind: 'malformed', reason: errorMessage(error) };
  }
};

const sameMessage = (saved: HandoverRead, record: HandoverRecord): boolean =>
  saved.kind === 'record' && JSON.stringify(saved.record) === JSON.stringify(record);

// Publishes once; a record already saved under the message ID is never replaced.
export const publishHandover = async (
  directory: string,
  record: HandoverRecord,
): Promise<PublishOutcome> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });

  try {
    publishRecord(recordPath(directory, record.messageId), record, {
      ...recordOptions,
      mode: 0o600,
    });

    return 'published';
  } catch (error) {
    if (!(error instanceof PublishError) || error.failure !== 'exists') {
      throw error;
    }
  }

  const saved = await readHandover(directory, record.messageId);

  return sameMessage(saved, record) ? 'existing' : 'changed';
};

// Lists saved records by message ID. Unpublished temporary files never match.
export const pendingHandovers = async (directory: string): Promise<string[]> => {
  try {
    const names = await readdir(directory);

    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((messageId) => isUuid(messageId))
      .toSorted();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

export const deleteHandover = async (directory: string, messageId: string): Promise<void> => {
  try {
    await unlink(recordPath(directory, messageId));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
};
