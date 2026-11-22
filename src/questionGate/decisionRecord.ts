import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { judgeQuestionSchema } from '../judgeSchema.ts';
import { isRecord } from '../schema.ts';
import type { ShadowRecordGap } from './record.ts';
import { readRecordFiles } from './recordFiles.ts';

export interface DecisionRecordRead {
  records: { path: string; record: DecisionRecord }[];
  gaps: ShadowRecordGap[];
}

export interface DecisionRecordReadOptions {
  label: string;
  version: number;
  schema: typeof decisionRecordSchema;
  check: (value: unknown) => string | undefined;
}

export type DecisionRecordReader = (
  path: string,
  options: DecisionRecordReadOptions,
) => Promise<DecisionRecord | undefined>;

export type DecisionRecordWriter = (
  path: string,
  value: DecisionRecord,
  mode?: number,
) => Promise<void>;

const recordVersion = 1;

const decisionFileMode = 0o600;

const decisionFileName =
  /^decision-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;

const unitIntervalSchema = Type.Number({ minimum: 0, maximum: 1 });

const decisionSchema = Type.Object(
  {
    question: judgeQuestionSchema,
    choice: Type.String(),
    reason: Type.String(),
    confidence: unitIntervalSchema,
  },
  { additionalProperties: false },
);

const decisionRecordSchema = Type.Object(
  {
    version: Type.Literal(recordVersion),
    kind: Type.Literal('decision'),
    time: Type.Number(),
    sessionId: Type.String({ minLength: 1 }),
    branch: Type.Union([Type.String(), Type.Null()]),
    head: Type.Union([Type.String(), Type.Null()]),
    cohort: Type.String({ minLength: 1 }),
    variant: Type.String({ minLength: 1, maxLength: 64 }),
    cutoff: unitIntervalSchema,
    decisions: Type.Array(decisionSchema, { minItems: 1, maxItems: 4 }),
  },
  { additionalProperties: false },
);

export type DecisionRecord = Static<typeof decisionRecordSchema>;

const singleDecisionProblem = (value: unknown): string | undefined => {
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
    (option): option is Record<string, unknown> =>
      isRecord(option) && option['recommended'] === true,
  );

  const onlyRecommended = recommended.length === 1 ? recommended[0] : undefined;

  if (onlyRecommended === undefined) {
    return 'question needs exactly one recommended option';
  }

  if (onlyRecommended['label'] === value['choice']) {
    return undefined;
  }

  return 'decision choice is not the recommended option label';
};

const decisionProblem = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const decisions = value['decisions'];

  if (!Array.isArray(decisions)) {
    return undefined;
  }

  for (const decision of decisions) {
    const problem = singleDecisionProblem(decision);

    if (problem !== undefined) {
      return problem;
    }
  }

  return undefined;
};

const decisionRecordOptions: DecisionRecordReadOptions = {
  label: 'decision record',
  version: recordVersion,
  schema: decisionRecordSchema,
  check: decisionProblem,
};

export const readDecisionRecords = async (
  directory: string,
  readRecord: DecisionRecordReader,
): Promise<DecisionRecordRead> => {
  const { entries, gaps } = await readRecordFiles(
    directory,
    decisionFileName,
    decisionRecordOptions.label,
    (path) => readRecord(path, decisionRecordOptions),
  );

  return { records: entries, gaps };
};

export const writeDecisionRecord = async (
  directory: string,
  record: DecisionRecord,
  writeRecord: DecisionRecordWriter,
): Promise<string> => {
  const path = join(directory, `decision-${randomUUID()}.json`);

  await writeRecord(path, record, decisionFileMode);

  return path;
};
