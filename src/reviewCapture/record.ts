import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../errors.js';
import { describeSchemaProblem } from '../schemaProblem.js';
import { objectNameSchema, pinnedTargetSchema, pinnedTargetSchemas } from './reviewCapture.js';

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

const schemaProblem = (value: unknown) => {
  const problem = targetProblem(value);

  if (problem !== undefined) {
    return problem;
  }

  return describeSchemaProblem(recordSchema(value), value);
};

const isNewerVersion = (value: unknown) => {
  const hasVersion = typeof value === 'object' && value !== null && 'version' in value;
  const version = hasVersion ? value.version : undefined;

  return typeof version === 'number' && version > currentVersion;
};

const parseRecord = (path: string, text: string): CaptureRecord => {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed capture record ${path}: not JSON.`, { cause: error });
  }

  if (isNewerVersion(value)) {
    throw new Error(
      `Capture record ${path} has a newer format than this Tau reads. Update Tau, then restart the session.`,
    );
  }

  const schema = recordSchema(value);

  if (!Value.Check(schema, value)) {
    throw new Error(`Malformed capture record ${path}: ${schemaProblem(value)}.`);
  }

  return value;
};

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

const isSymlink = async (path: string) => {
  try {
    const stats = await lstat(path);

    return stats.isSymbolicLink();
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }

    throw error;
  }
};

// Writes a new file and renames it over the record, so a failed write keeps the old record or none.
// The rename is the step that completes a capture.
export const writeCaptureRecord = async (
  directory: string,
  record: CurrentCaptureRecord,
): Promise<void> => {
  const path = join(directory, recordFileName);
  const temporary = join(directory, `.${recordFileName}.${randomUUID()}`);

  if (await isSymlink(path)) {
    throw new Error(`Refusing to write through a symlink: ${path}`);
  }

  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });

    throw error;
  }
};
