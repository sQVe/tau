import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage, isMissingFile } from '../errors.js';
import { parseVersionedRecord, writeRecord } from '../record.js';
import { isUuid, requestByteLimit, uuidSchema, withBody } from './protocol.js';

export type InboxRecord = Static<typeof recordSchema>;

export type InboxRead =
  | { kind: 'record'; record: InboxRecord }
  | { kind: 'missing' }
  | { kind: 'malformed'; reason: string };

export type SaveOutcome = 'saved' | 'existing' | 'changed';

const recordVersion = 1;

const recordSchema = withBody({ version: Type.Literal(recordVersion), messageId: uuidSchema });

const recordOptions = { label: 'inbox record', version: recordVersion, schema: recordSchema };

const recordByteLimit = 2 * requestByteLimit;

const recordPath = (directory: string, messageId: string): string =>
  join(directory, `${messageId}.json`);

const readRecord = async (path: string): Promise<InboxRecord> => {
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

const sameMessage = (saved: InboxRead, record: InboxRecord): boolean =>
  saved.kind === 'record' && JSON.stringify(saved.record) === JSON.stringify(record);

export const saveMessage = async (directory: string, record: InboxRecord): Promise<SaveOutcome> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const saved = await readMessage(directory, record.messageId);

  if (saved.kind !== 'missing') {
    return sameMessage(saved, record) ? 'existing' : 'changed';
  }

  await writeRecord(recordPath(directory, record.messageId), record);

  return 'saved';
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
