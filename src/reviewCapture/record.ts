import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../errors.js';
import { parseVersionedRecord, writeRecord } from '../record.js';
import { objectNameSchema, pinnedTargetSchema, pinnedTargetSchemas } from './target.js';

export const recordFileName = 'capture.json';
export const inputFileName = 'input.md';
export const recheckFileName = 'recheck.diff';

const currentVersion = 2;

// What a fix review compares against: the working tree files an earlier capture saved in the
// review directory's snapshot folder, and the paths it could not save.
const snapshotSchema = Type.Object(
  {
    present: Type.Array(Type.String({ minLength: 1 })),
    absent: Type.Array(Type.String({ minLength: 1 })),
    skipped: Type.Array(
      Type.Object(
        {
          kind: Type.Union([
            Type.Literal('binary'),
            Type.Literal('unreadable'),
            Type.Literal('submodule'),
          ]),
          path: Type.String({ minLength: 1 }),
          // The blob of the file at capture time, or null when it could not be read.
          identity: Type.Union([objectNameSchema, Type.Null()]),
          // Whether the path existed at capture time, so its later deletion counts as a change.
          existed: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type Snapshot = Static<typeof snapshotSchema>;

const captureRecordSchema = Type.Object(
  {
    version: Type.Literal(currentVersion),
    target: pinnedTargetSchema,
    base: Type.Union([objectNameSchema, Type.Null()]),
    head: objectNameSchema,
    hash: objectNameSchema,
    snapshot: Type.Optional(snapshotSchema),
  },
  { additionalProperties: false },
);

// Version 1 had no fix target and saved no snapshot. It is read only so a fix review can refuse it.
const versionOneRecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    target: Type.Union([
      pinnedTargetSchemas.workingTree,
      pinnedTargetSchemas.range,
      pinnedTargetSchemas.rootCommit,
      pinnedTargetSchemas.files,
    ]),
    base: Type.Union([objectNameSchema, Type.Null()]),
    head: objectNameSchema,
    hash: objectNameSchema,
  },
  { additionalProperties: false },
);

export type CaptureRecord =
  | Static<typeof captureRecordSchema>
  | Static<typeof versionOneRecordSchema>;

export type CurrentCaptureRecord = Static<typeof captureRecordSchema>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isTargetKind = (kind: unknown): kind is keyof typeof pinnedTargetSchemas =>
  typeof kind === 'string' && Object.hasOwn(pinnedTargetSchemas, kind);

// A union reports the errors of every member, so the target is checked against its own kind.
const targetProblem = (value: unknown) => {
  const target = isObject(value) ? value['target'] : undefined;
  const kind = isObject(target) ? target['kind'] : undefined;

  if (!isTargetKind(kind)) {
    return undefined;
  }

  const [error] = Value.Errors(pinnedTargetSchemas[kind], target);

  return error === undefined ? undefined : `/target${error.instancePath} ${error.message}`;
};

const isVersionOne = (value: unknown) => isObject(value) && value['version'] === 1;

const recordSchema = (value: unknown) =>
  isVersionOne(value) ? versionOneRecordSchema : captureRecordSchema;

const parseRecord = (path: string, text: string) =>
  parseVersionedRecord(path, text, {
    label: 'capture record',
    version: currentVersion,
    schema: recordSchema,
    check: targetProblem,
  });

export const readCaptureRecord = async (directory: string): Promise<CaptureRecord> => {
  const path = join(directory, recordFileName);
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`No capture record at ${path}. Run capture first.`, { cause: error });
    }

    throw error;
  }

  return parseRecord(path, text);
};

export const writeCaptureRecord = async (
  directory: string,
  record: CurrentCaptureRecord,
): Promise<void> => {
  await writeRecord(join(directory, recordFileName), record);
};
