import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../errors.js';
import { objectNameSchema, pinnedTargetSchema, pinnedTargetSchemas } from './reviewCapture.js';

export const recordFileName = 'capture.json';
export const inputFileName = 'input.md';
export const recheckFileName = 'recheck.diff';

const currentVersion = 1;

const captureRecordSchema = Type.Object(
  {
    version: Type.Literal(currentVersion),
    target: pinnedTargetSchema,
    base: Type.Union([objectNameSchema, Type.Null()]),
    head: objectNameSchema,
    hash: objectNameSchema,
  },
  { additionalProperties: false },
);

export type CaptureRecord = Static<typeof captureRecordSchema>;

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

const schemaProblem = (value: unknown) => {
  const problem = targetProblem(value);

  if (problem !== undefined) {
    return problem;
  }

  const [error] = Value.Errors(captureRecordSchema, value);

  return error === undefined ? 'unknown problem' : `${error.instancePath || '/'} ${error.message}`;
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

  if (!Value.Check(captureRecordSchema, value)) {
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

export const writeCaptureRecord = async (
  directory: string,
  record: CaptureRecord,
): Promise<void> => {
  await writeFile(join(directory, recordFileName), `${JSON.stringify(record, null, 2)}\n`);
};
