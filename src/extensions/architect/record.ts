import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { isMissingFile } from '../../errors.js';
import { readVersionedRecord, writeRecord } from '../../record.js';
import { ensureTauDirectory } from '../../tauDirectory.js';

const choiceOutcomeSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('answered'),
    label: Type.String(),
    confidence: Type.Number(),
  }),
  Type.Object({ kind: Type.Literal('timeout') }),
  Type.Object({ kind: Type.Literal('error') }),
  Type.Object({ kind: Type.Literal('unavailable') }),
]);

const architectRecordSchema = Type.Object({
  version: Type.Literal(1),
  sessionFile: Type.Union([Type.String(), Type.Null()]),
  terminal: Type.Union([Type.String(), Type.Null()]),
  leadTerminal: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.String(),
});

export type ArchitectRecord = Static<typeof architectRecordSchema>;

const gateRecordSchema = Type.Object({
  version: Type.Literal(1),
  createdAt: Type.String(),
  request: Type.String(),
  restatement: Type.String(),
  outcome: choiceOutcomeSchema,
  decision: Type.Union([
    Type.Literal('specified'),
    Type.Literal('open'),
    Type.Literal('uncertain'),
  ]),
  label: Type.Union([Type.String(), Type.Null()]),
  confidence: Type.Union([Type.Number(), Type.Null()]),
});

export type GateRecord = Static<typeof gateRecordSchema>;

const askStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('sent'),
  Type.Literal('timeout'),
  Type.Literal('failed'),
]);

export type AskStatus = Static<typeof askStatusSchema>;

const askRecordSchema = Type.Object({
  version: Type.Literal(1),
  askId: Type.String(),
  createdAt: Type.String(),
  question: Type.String(),
  sessionFile: Type.String(),
  terminal: Type.Union([Type.String(), Type.Null()]),
  leadTerminal: Type.String(),
  deadline: Type.Number(),
  status: askStatusSchema,
  detail: Type.Union([Type.String(), Type.Null()]),
  answer: Type.Union([Type.String(), Type.Null()]),
});

export type AskRecord = Static<typeof askRecordSchema>;

export const architectRecordPath = (root: string): string =>
  join(root, '.tau', 'architect', 'record.json');

export const gateRecordDirectory = (root: string): string => join(root, '.tau', 'lead', 'gate');

export const askRecordDirectory = (root: string): string => join(root, '.tau', 'lead', 'ask');

export const askRecordPath = (root: string, askId: string): string =>
  join(askRecordDirectory(root), `${askId}.json`);

const recordOptions = {
  label: 'architect record',
  version: 1,
  schema: architectRecordSchema,
} as const;

export const readArchitectRecord = (root: string): Promise<ArchitectRecord | undefined> =>
  readVersionedRecord(architectRecordPath(root), recordOptions);

export const writeArchitectRecord = async (
  root: string,
  record: ArchitectRecord,
): Promise<void> => {
  await ensureTauDirectory(root, 'architect');
  await writeRecord(architectRecordPath(root), record);
};

export const readGateRecord = (root: string, name: string): Promise<GateRecord | undefined> =>
  readVersionedRecord(join(gateRecordDirectory(root), name), {
    label: 'gate record',
    version: 1,
    schema: gateRecordSchema,
  });

export const writeGateRecord = async (root: string, record: GateRecord): Promise<string> => {
  await ensureTauDirectory(root, 'lead/gate');

  const path = join(gateRecordDirectory(root), `${randomUUID()}.json`);

  await writeRecord(path, record);

  return path;
};

export const readAskRecordAt = (path: string): Promise<AskRecord | undefined> =>
  readVersionedRecord(path, {
    label: 'ask record',
    version: 1,
    schema: askRecordSchema,
  });

export const writeAskRecordAt = (path: string, record: AskRecord): Promise<void> =>
  writeRecord(path, record);

export const readAskRecord = (root: string, askId: string): Promise<AskRecord | undefined> =>
  readAskRecordAt(askRecordPath(root, askId));

export const writeAskRecord = async (root: string, record: AskRecord): Promise<void> => {
  await ensureTauDirectory(root, 'lead/ask');
  await writeAskRecordAt(askRecordPath(root, record.askId), record);
};

export const readAskRecords = async (root: string): Promise<AskRecord[]> => {
  const names = await readdir(askRecordDirectory(root)).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  });

  const recordReads = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readAskRecordAt(join(askRecordDirectory(root), name)));

  const records = await Promise.all(recordReads);

  return records
    .filter((record): record is AskRecord => record !== undefined)
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.askId.localeCompare(right.askId),
    );
};
