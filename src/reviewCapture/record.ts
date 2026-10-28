import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../errors.js';
import { parseVersionedRecord } from '../record.js';
import { objectNameSchema, pinnedTargetSchema, pinnedTargetSchemas } from './target.js';

export const recordFileName = 'capture.json';
export const inputFileName = 'input.md';
export const recheckFileName = 'recheck.diff';
export const generationFolderName = 'capture';
export const generationPatchFileName = 'patch.diff';
export const generationInputFileName = 'input.md';
export const snapshotFolder = 'snapshot';

export const isRepositoryPath = (path: string): boolean => {
  const segments = path.split('/');

  return !isAbsolute(path) && !segments.includes('..') && !segments.includes('');
};

const versionThree = 3;
const versionFour = 4;
const currentVersion = 5;

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

const savedFields = {
  target: pinnedTargetSchema,
  base: Type.Union([objectNameSchema, Type.Null()]),
  head: objectNameSchema,
  hash: objectNameSchema,
  snapshot: Type.Optional(snapshotSchema),
};

const versionTwoRecordSchema = Type.Object(
  { version: Type.Literal(2), ...savedFields },
  { additionalProperties: false },
);

const gapSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('binary'),
      Type.Literal('unreadable'),
      Type.Literal('excluded'),
      Type.Literal('unmatched'),
      Type.Literal('submodule'),
    ]),
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const originalSchema = Type.Object(
  { patch: objectNameSchema, input: objectNameSchema, snapshot: Type.Optional(objectNameSchema) },
  { additionalProperties: false },
);

const versionThreeFields = {
  ...savedFields,
  gaps: Type.Array(gapSchema),
  original: originalSchema,
};

const versionThreeRecordSchema = Type.Object(
  { version: Type.Literal(versionThree), ...versionThreeFields },
  { additionalProperties: false },
);

const endpointSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal('complete'),
      baseTree: objectNameSchema,
      tree: objectNameSchema,
      ref: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Union([Type.Literal('unsupported'), Type.Literal('incomplete')]),
      reasons: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export type RecordedEndpoint = Static<typeof endpointSchema>;

const versionFourFields = { ...versionThreeFields, endpoint: endpointSchema };

const versionFourRecordSchema = Type.Object(
  { version: Type.Literal(versionFour), ...versionFourFields },
  { additionalProperties: false },
);

const versionFiveRecordSchema = Type.Object(
  { version: Type.Literal(currentVersion), ...versionFourFields },
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
  | Static<typeof versionOneRecordSchema>
  | Static<typeof versionTwoRecordSchema>
  | Static<typeof versionThreeRecordSchema>
  | Static<typeof versionFourRecordSchema>
  | Static<typeof versionFiveRecordSchema>;

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

const claimsVersion = (value: unknown, version: number) =>
  isObject(value) && value['version'] === version;

const predecessorProblem = (value: unknown) => {
  const target = isObject(value) ? value['target'] : undefined;
  const named = isObject(target) && Object.hasOwn(target, 'predecessor');

  return named && !claimsVersion(value, currentVersion)
    ? `/target/predecessor needs version ${currentVersion}`
    : undefined;
};

const recordProblem = (value: unknown) => targetProblem(value) ?? predecessorProblem(value);

const recordSchema = (value: unknown) => {
  if (claimsVersion(value, 1)) {
    return versionOneRecordSchema;
  }

  if (claimsVersion(value, versionThree)) {
    return versionThreeRecordSchema;
  }

  if (claimsVersion(value, versionFour)) {
    return versionFourRecordSchema;
  }

  return claimsVersion(value, currentVersion) ? versionFiveRecordSchema : versionTwoRecordSchema;
};

export const parseCaptureRecord = (path: string, text: string): CaptureRecord =>
  parseVersionedRecord(path, text, {
    label: 'capture record',
    version: currentVersion,
    schema: recordSchema,
    check: recordProblem,
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

  return parseCaptureRecord(path, text);
};
