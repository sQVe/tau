import { lstatSync, mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { errorMessage, hasErrorCode, isMissingFile } from '../../errors.js';
import {
  parseVersionedRecord,
  PublishError,
  publishTextSync,
  readContainedText,
  serializeRecord,
} from '../../record.js';
import { describeSchemaProblem, isRecord } from '../../schema.js';
import { assignmentDirectory, uuidPattern } from './assignment.js';

export type AnswerRead =
  | { kind: 'answered'; record: AnswerRecord }
  | { kind: 'unanswered' }
  | { kind: 'refused'; reason: string };

export interface AnswerReference {
  assignmentId: string;
  questionId: string;
  answerPath: string;
}

export const answerByteLimit = 32_000;

const escapedByteGrowth = 6;

const recordFieldBytes = 4096;

const recordByteLimit = answerByteLimit * escapedByteGrowth + recordFieldBytes;

const answerVersion = 1;

const answersDirectoryName = 'answers';

const uuid = Type.String({ pattern: uuidPattern });

const answerSchema = Type.Object(
  {
    version: Type.Literal(answerVersion),
    assignmentId: uuid,
    questionId: uuid,
    answeredAt: Type.Integer({ minimum: 1 }),
    answer: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type AnswerRecord = Static<typeof answerSchema>;

const referenceSchema = Type.Object(
  { assignmentId: uuid, questionId: uuid, answerPath: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const isUuid = (value: string): boolean => new RegExp(uuidPattern).test(value);

const answerProblem = (value: unknown): string | undefined => {
  if (!isRecord(value) || typeof value['answer'] !== 'string') {
    return undefined;
  }

  const bytes = Buffer.byteLength(value['answer'], 'utf8');

  return bytes > answerByteLimit ? `/answer is larger than ${answerByteLimit} bytes` : undefined;
};

const answerOptions = {
  label: 'answer record',
  version: answerVersion,
  schema: answerSchema,
  check: answerProblem,
};

const answersDirectory = (assignmentId: string): string =>
  join(assignmentDirectory(assignmentId), answersDirectoryName);

export const answerPath = (assignmentId: string, questionId: string): string =>
  join(answersDirectory(assignmentId), `${questionId}.json`);

const checkAnswer = (record: AnswerRecord): void => {
  if (!Value.Check(answerSchema, record)) {
    throw new Error(`Malformed answer: ${describeSchemaProblem(answerSchema, record)}.`);
  }

  const problem = answerProblem(record);

  if (problem !== undefined) {
    throw new Error(`Refusing the answer for question ${record.questionId}: ${problem}.`);
  }
};

const refuseSymlink = (directory: string): void => {
  if (lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Refusing to write an answer through a symlink: ${directory}`);
  }
};

const makeAnswersDirectory = (directory: string): void => {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }

  refuseSymlink(directory);
};

export const publishAnswer = (record: AnswerRecord): string => {
  checkAnswer(record);

  refuseSymlink(assignmentDirectory(record.assignmentId));
  makeAnswersDirectory(answersDirectory(record.assignmentId));

  const path = answerPath(record.assignmentId, record.questionId);

  try {
    publishTextSync(path, serializeRecord(record), { mode: 0o600 });
  } catch (error) {
    if (error instanceof PublishError && error.failure === 'exists') {
      throw new Error(
        `Question ${record.questionId} already has an answer: ${path}. The first answer stays.`,
        { cause: error },
      );
    }

    throw error;
  }

  return path;
};

const hasMissingCause = (error: unknown): boolean =>
  error instanceof Error && isMissingFile(error.cause);

const identityProblem = (
  record: AnswerRecord,
  assignmentId: string,
  questionId: string,
): string | undefined => {
  if (record.assignmentId !== assignmentId) {
    return `The answer names assignment ${record.assignmentId}, not ${assignmentId}.`;
  }

  if (record.questionId !== questionId) {
    return `The answer names question ${record.questionId}, not ${questionId}.`;
  }

  return undefined;
};

const readAnswerText = async (
  assignmentId: string,
  questionId: string,
): Promise<string | undefined> => {
  const directory = join(await realpath(dirname(assignmentDirectory(assignmentId))), assignmentId);

  try {
    return await readContainedText({
      directory,
      path: join(directory, answersDirectoryName, `${questionId}.json`),
      byteLimit: recordByteLimit,
      label: 'answer record',
    });
  } catch (error) {
    if (hasMissingCause(error)) {
      return undefined;
    }

    throw error;
  }
};

export const readAnswer = async (assignmentId: string, questionId: string): Promise<AnswerRead> => {
  if (!isUuid(assignmentId)) {
    return { kind: 'refused', reason: `Not an assignment ID: ${assignmentId}` };
  }

  if (!isUuid(questionId)) {
    return { kind: 'refused', reason: `Not a question ID: ${questionId}` };
  }

  const path = answerPath(assignmentId, questionId);
  let record: AnswerRecord;

  try {
    const text = await readAnswerText(assignmentId, questionId);

    if (text === undefined) {
      return { kind: 'unanswered' };
    }

    record = parseVersionedRecord(path, text, answerOptions);
  } catch (error) {
    return { kind: 'refused', reason: errorMessage(error) };
  }

  const problem = identityProblem(record, assignmentId, questionId);

  return problem === undefined
    ? { kind: 'answered', record }
    : { kind: 'refused', reason: problem };
};

export const formatAnswerReference = (assignmentId: string, questionId: string): string =>
  JSON.stringify({
    assignmentId,
    questionId,
    answerPath: answerPath(assignmentId, questionId),
  } satisfies AnswerReference);

export const parseAnswerReference = (text: string): AnswerReference => {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('Malformed answer reference: not JSON.', { cause: error });
  }

  if (!Value.Check(referenceSchema, value)) {
    throw new Error(
      `Malformed answer reference: ${describeSchemaProblem(referenceSchema, value)}.`,
    );
  }

  const expected = answerPath(value.assignmentId, value.questionId);

  if (value.answerPath !== expected) {
    throw new Error(`The answer reference names ${value.answerPath}, not ${expected}.`);
  }

  return value;
};
