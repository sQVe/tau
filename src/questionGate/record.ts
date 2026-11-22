import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { judgeQuestionSchema } from '../judgeSchema.ts';
import { isRecord } from '../schema.ts';
import { readRecordFiles } from './recordFiles.ts';

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

export const readShadowRecords = async (
  directory: string,
  readRecord: ShadowRecordReader,
): Promise<ShadowRecordRead> => {
  const { entries, gaps } = await readRecordFiles(
    directory,
    shadowFileName,
    recordOptions.label,
    (path) => readRecord(path, recordOptions),
  );

  return { records: entries.map((entry) => entry.record), gaps };
};

export const writeShadowRecord = async (
  directory: string,
  record: ShadowRecord,
  writeRecord: ShadowRecordWriter,
): Promise<void> => {
  const path = join(directory, `shadow-${randomUUID()}.json`);

  await writeRecord(path, record, shadowFileMode);
};
