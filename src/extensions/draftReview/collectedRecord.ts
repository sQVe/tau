import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../../errors.js';
import { describeSchemaProblem } from '../../schemaProblem.js';
import { replaceFile } from './replaceFile.js';

const recordName = 'collected.json';
const recordVersion = 1;

const recordSchema = Type.Object(
  {
    version: Type.Literal(recordVersion),
    comments: Type.Array(
      Type.Object(
        {
          sessionPath: Type.String({ minLength: 1 }),
          id: Type.String({ minLength: 1 }),
          deleted: Type.Boolean(),
          path: Type.String({ minLength: 1 }),
          startLine: Type.Union([Type.Number(), Type.Null()]),
          endLine: Type.Union([Type.Number(), Type.Null()]),
          type: Type.String(),
          content: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    edits: Type.Array(
      Type.Object(
        {
          // Relative to the `.tau` directory.
          path: Type.String({ minLength: 1 }),
          diff: Type.String(),
          // The user's version, written to the real file while the status is pending.
          staged: Type.String(),
          status: Type.Union([
            Type.Literal('pending'),
            Type.Literal('applied'),
            Type.Literal('conflict'),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type CollectedRecord = Omit<Static<typeof recordSchema>, 'version'>;

// The full collected result, saved before any delete or write-back so a retry can finish the rest.
export const saveCollectedRecord = async (
  recordDirectory: string,
  record: CollectedRecord,
): Promise<void> => {
  const path = join(recordDirectory, recordName);

  await replaceFile(path, JSON.stringify({ version: recordVersion, ...record }, null, 2));
};

const isNewerVersion = (value: unknown) => {
  const version =
    typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined;

  return typeof version === 'number' && version > recordVersion;
};

const parseRecord = (path: string, content: string): Static<typeof recordSchema> => {
  let value: unknown;

  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Malformed collected review ${path}: not JSON.`, { cause: error });
  }

  if (isNewerVersion(value)) {
    throw new Error(
      `Collected review ${path} has a newer format than this Tau reads. Update Tau, then restart the session.`,
    );
  }

  if (!Value.Check(recordSchema, value)) {
    throw new Error(
      `Malformed collected review ${path}: ${describeSchemaProblem(recordSchema, value)}.`,
    );
  }

  return value;
};

export const loadCollectedRecord = async (
  recordDirectory: string,
): Promise<CollectedRecord | undefined> => {
  const path = join(recordDirectory, recordName);
  let content: string;

  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }

  const parsed = parseRecord(path, content);

  return { comments: parsed.comments, edits: parsed.edits };
};
