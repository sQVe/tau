import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage, isMissingFile } from '../errors.js';
import { parseVersionedRecord, writeFencedRecord, writeRecord } from '../record.js';
import type { RecordFence } from '../record.js';
import { isRecord } from '../schema.js';
import {
  answerBody,
  handoverBody,
  handoverQuestionBody,
  isUuid,
  requestByteLimit,
  uuidSchema,
  withSavableBody,
} from './protocol.js';

export type InboxRecord = Static<typeof recordSchema>;

type Version3InboxRecord = Static<typeof version3RecordSchema>;

type Version2InboxRecord = Static<typeof version2RecordSchema>;

type PreviousInboxRecord = Static<typeof previousRecordSchema>;

type SavedInboxRecord =
  | InboxRecord
  | Version3InboxRecord
  | Version2InboxRecord
  | PreviousInboxRecord;

export type InboxRead =
  | { kind: 'record'; record: SavedInboxRecord }
  | { kind: 'missing' }
  | { kind: 'malformed'; reason: string };

export type SaveOutcome = 'saved' | 'existing' | 'changed' | { refused: string };

export interface SaveOptions {
  // Checked when the record is published, in the same synchronous step as the publish. A reason
  // publishes nothing.
  fence?: RecordFence | undefined;
}

export const inboxRecordVersion = 4;

const version3RecordVersion = 3;

const strict = { additionalProperties: false } as const;

const previousRecordSchema = Type.Union([
  Type.Object(
    {
      version: Type.Literal(1),
      messageId: uuidSchema,
      family: Type.Literal('handover'),
      payload: Type.Object({ text: Type.String({ minLength: 1 }) }, strict),
    },
    strict,
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      messageId: uuidSchema,
      family: Type.Literal('answer'),
      payload: Type.Object(
        {
          assignmentId: uuidSchema,
          questionId: uuidSchema,
          parentSession: Type.String({ minLength: 1 }),
          answer: Type.String({ minLength: 1 }),
        },
        strict,
      ),
    },
    strict,
  ),
]);

const version2RecordSchema = Type.Union([
  Type.Object({ version: Type.Literal(2), messageId: uuidSchema, ...handoverBody }, strict),
  Type.Object({ version: Type.Literal(2), messageId: uuidSchema, ...answerBody }, strict),
]);

const version3RecordSchema = Type.Union([
  Type.Object(
    { version: Type.Literal(version3RecordVersion), messageId: uuidSchema, ...handoverBody },
    strict,
  ),
  Type.Object(
    { version: Type.Literal(version3RecordVersion), messageId: uuidSchema, ...answerBody },
    strict,
  ),
  Type.Object(
    {
      version: Type.Literal(version3RecordVersion),
      messageId: uuidSchema,
      ...handoverQuestionBody,
    },
    strict,
  ),
]);

const recordSchema = withSavableBody({
  version: Type.Literal(inboxRecordVersion),
  messageId: uuidSchema,
});

const savedVersion = (value: unknown): unknown => (isRecord(value) ? value['version'] : undefined);

const schemaFor = (value: unknown) => {
  switch (savedVersion(value)) {
    case 1:
      return previousRecordSchema;
    case 2:
      return version2RecordSchema;
    case version3RecordVersion:
      return version3RecordSchema;
    default:
      return recordSchema;
  }
};

const recordOptions = {
  label: 'inbox record',
  version: inboxRecordVersion,
  schema: schemaFor,
};

const recordByteLimit = 2 * requestByteLimit;

const recordPath = (directory: string, messageId: string): string =>
  join(directory, `${messageId}.json`);

const readRecord = async (path: string): Promise<SavedInboxRecord> => {
  const text = await readFile(path, 'utf8');

  if (Buffer.byteLength(text) > recordByteLimit) {
    throw new Error(`Inbox record ${path} is larger than ${String(recordByteLimit)} bytes.`);
  }

  return parseVersionedRecord(path, text, recordOptions);
};

export const readMessage = async (directory: string, messageId: string): Promise<InboxRead> => {
  try {
    return { kind: 'record', record: await readRecord(recordPath(directory, messageId)) };
  } catch (error) {
    if (isMissingFile(error)) {
      return { kind: 'missing' };
    }

    return { kind: 'malformed', reason: errorMessage(error) };
  }
};

const sameRecord = (saved: SavedInboxRecord, record: InboxRecord): boolean =>
  saved.messageId === record.messageId &&
  saved.family === record.family &&
  JSON.stringify(saved.payload) === JSON.stringify(record.payload);

const sameMessage = (saved: InboxRead, record: InboxRecord): boolean =>
  saved.kind === 'record' && sameRecord(saved.record, record);

export const saveMessage = async (
  directory: string,
  record: InboxRecord,
  options: SaveOptions = {},
): Promise<SaveOutcome> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const saved = await readMessage(directory, record.messageId);

  if (saved.kind !== 'missing') {
    return sameMessage(saved, record) ? 'existing' : 'changed';
  }

  const path = recordPath(directory, record.messageId);

  if (options.fence === undefined) {
    await writeRecord(path, record);

    return 'saved';
  }

  const reason = await writeFencedRecord(path, record, options.fence);

  return reason === undefined ? 'saved' : { refused: reason };
};

export const pendingMessages = async (directory: string): Promise<string[]> => {
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

export const deleteMessage = async (directory: string, messageId: string): Promise<void> => {
  try {
    await unlink(recordPath(directory, messageId));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
};
