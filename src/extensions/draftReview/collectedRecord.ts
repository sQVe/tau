import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { readVersionedRecord, writeRecord } from '../../record.js';

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

  await writeRecord(path, { version: recordVersion, ...record });
};

export const loadCollectedRecord = async (
  recordDirectory: string,
): Promise<CollectedRecord | undefined> => {
  const path = join(recordDirectory, recordName);

  const parsed = await readVersionedRecord(path, {
    label: 'collected review',
    version: recordVersion,
    schema: recordSchema,
  });

  return parsed === undefined ? undefined : { comments: parsed.comments, edits: parsed.edits };
};
