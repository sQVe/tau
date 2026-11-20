import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage, isMissingFile } from '../errors.ts';
import { judgeQuestionSchema } from '../judgeSchema.ts';
import { isRecord } from '../schema.ts';

export interface ShadowRecordGap {
  path: string;
  reason: string;
}

export interface ShadowRecordRead {
  records: ShadowRecord[];
  gaps: ShadowRecordGap[];
}

export interface ShadowRecordReadOptions {
  label: string;
  version: number;
  schema: typeof recordSchema;
  check: (value: unknown) => string | undefined;
}

export type ShadowRecordReader = (
  path: string,
  options: ShadowRecordReadOptions,
) => Promise<ShadowRecord | undefined>;

export type ShadowRecordWriter = (
  path: string,
  value: ShadowRecord,
  mode?: number,
) => Promise<void>;

const recordVersion = 1;

const shadowFileMode = 0o600;

const shadowFileName =
  /^shadow-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;

const confidenceSchema = Type.Number({ minimum: 0, maximum: 1 });

const judgeVerdictSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('answered'), confidence: confidenceSchema },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('timeout') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('error') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('unavailable') }, { additionalProperties: false }),
]);

const judgeTimingSchema = Type.Object(
  {
    verdict: judgeVerdictSchema,
    milliseconds: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const judgesSchema = Type.Object(
  {
    classifier: judgeTimingSchema,
    classifierExamples: judgeTimingSchema,
    panel: judgeTimingSchema,
    panelExamples: judgeTimingSchema,
    agent: judgeTimingSchema,
  },
  { additionalProperties: false },
);

const answerSchema = Type.Union([
  Type.Object({ kind: Type.Literal('declined') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('answered'),
      selected: Type.Array(Type.String()),
      typed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

const recordSchema = Type.Object(
  {
    version: Type.Literal(recordVersion),
    kind: Type.Literal('shadow'),
    cohort: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    question: judgeQuestionSchema,
    confidence: Type.Union([confidenceSchema, Type.Null()]),
    judges: judgesSchema,
    answer: answerSchema,
  },
  { additionalProperties: false },
);

export type ShadowRecord = Static<typeof recordSchema>;

const recommendedCountProblem = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const question = value['question'];

  if (!isRecord(question)) {
    return undefined;
  }

  const options = question['options'];

  if (!Array.isArray(options)) {
    return undefined;
  }

  const recommended = options.filter(
    (option) => isRecord(option) && option['recommended'] === true,
  ).length;

  return recommended === 1 ? undefined : 'question needs exactly one recommended option';
};

const recordOptions: ShadowRecordReadOptions = {
  label: 'shadow record',
  version: recordVersion,
  schema: recordSchema,
  check: recommendedCountProblem,
};

const listShadowNames = async (directory: string): Promise<string[]> => {
  try {
    const names = await readdir(directory);

    return names.filter((name) => shadowFileName.test(name)).toSorted();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw new Error(`Could not read shadow records in ${directory}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
};

const isSingleRegularFile = async (path: string): Promise<boolean> => {
  const stats = await lstat(path);

  return stats.isFile() && stats.nlink === 1;
};

export const readShadowRecords = async (
  directory: string,
  readRecord: ShadowRecordReader,
): Promise<ShadowRecordRead> => {
  const names = await listShadowNames(directory);
  const records: ShadowRecord[] = [];
  const gaps: ShadowRecordGap[] = [];

  for (const name of names) {
    const path = join(directory, name);

    try {
      // oxlint-disable-next-line no-await-in-loop -- Reading in name order keeps gap order stable.
      const regular = await isSingleRegularFile(path);

      if (!regular) {
        gaps.push({ path, reason: `Shadow record ${path} is not a regular file with one link.` });

        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- Reading in name order keeps gap order stable.
      const record = await readRecord(path, recordOptions);

      if (record === undefined) {
        gaps.push({
          path,
          reason: `Shadow record ${path} disappeared before it could be read.`,
        });

        continue;
      }

      records.push(record);
    } catch (error) {
      gaps.push({ path, reason: errorMessage(error) });
    }
  }

  return { records, gaps };
};

export const writeShadowRecord = async (
  directory: string,
  record: ShadowRecord,
  writeRecord: ShadowRecordWriter,
): Promise<void> => {
  const path = join(directory, `shadow-${randomUUID()}.json`);

  await writeRecord(path, record, shadowFileMode);
};
