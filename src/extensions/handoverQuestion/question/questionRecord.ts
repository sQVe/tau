import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { errorMessage, isMissingFile } from '../../../errors.js';
import { senderTerminalPattern } from '../../../handoverSender.js';
import { isUuid, sessionIdSchema, uuidSchema } from '../../../inbox/inbox.js';
import { readVersionedRecord, writeRecord } from '../../../record.js';
import { describeSchemaProblem } from '../../../schema.js';
import { ensureTauDirectory, rejectLinkedFile, rejectTauSymlinks } from '../../../tauDirectory.js';

export type QuestionRead =
  | { kind: 'record'; record: QuestionRecord }
  | { kind: 'missing' }
  | { kind: 'malformed'; reason: string };

const questionRecordVersion = 1;

const strict = { additionalProperties: false } as const;

const isoTimePattern = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`;

const withoutFraction = (value: string): string => value.replace(/\.\d+Z$/u, 'Z');

const isRealUtcTime = (value: string): boolean => {
  const time = Date.parse(value);

  return (
    !Number.isNaN(time) && withoutFraction(new Date(time).toISOString()) === withoutFraction(value)
  );
};

const isoTime = Type.Refine(Type.String({ pattern: isoTimePattern }), isRealUtcTime);

const questionFields = {
  version: Type.Literal(questionRecordVersion),
  questionId: uuidSchema,
  askerTerminal: Type.String({ pattern: senderTerminalPattern }),
  askerSession: sessionIdSchema,
  senderTerminal: Type.String({ pattern: senderTerminalPattern }),
  senderSession: sessionIdSchema,
  text: Type.String({ minLength: 1, maxLength: 4000 }),
  askedAt: isoTime,
};

const questionRecordSchema = Type.Union([
  Type.Object({ ...questionFields, state: Type.Literal('open'), answer: Type.Null() }, strict),
  Type.Object(
    { ...questionFields, state: Type.Literal('answered'), answer: Type.String({ minLength: 1 }) },
    strict,
  ),
]);

export type QuestionRecord = Static<typeof questionRecordSchema>;

export const questionRecordDirectory = (root: string): string =>
  join(root, '.tau', 'handoverQuestions');

const notUuidReason = (questionId: string): string =>
  `Question ID ${JSON.stringify(questionId)} is not a UUID.`;

const mismatchReason = (requested: string, found: string): string =>
  `Question ID ${JSON.stringify(found)} does not match requested ${JSON.stringify(requested)}.`;

const questionRecordProblem = (record: QuestionRecord): string | undefined =>
  Value.Check(questionRecordSchema, record)
    ? undefined
    : `Malformed handover question record: ${describeSchemaProblem(questionRecordSchema, record)}.`;

const questionRecordPath = (root: string, questionId: string): string => {
  if (!isUuid(questionId)) {
    throw new Error(notUuidReason(questionId));
  }

  return join(questionRecordDirectory(root), `${questionId}.json`);
};

export const readQuestionRecord = async (
  root: string,
  questionId: string,
): Promise<QuestionRead> => {
  if (!isUuid(questionId)) {
    return { kind: 'malformed', reason: notUuidReason(questionId) };
  }

  const path = questionRecordPath(root, questionId);

  try {
    await rejectTauSymlinks(root, 'handoverQuestions');
    await rejectLinkedFile(path, 'read');

    const record = await readVersionedRecord(path, {
      label: 'handover question record',
      version: questionRecordVersion,
      schema: questionRecordSchema,
    });

    if (record === undefined) {
      return { kind: 'missing' };
    }

    if (record.questionId !== questionId) {
      return { kind: 'malformed', reason: mismatchReason(questionId, record.questionId) };
    }

    return { kind: 'record', record };
  } catch (error) {
    return { kind: 'malformed', reason: errorMessage(error) };
  }
};

export const writeQuestionRecord = async (
  root: string,
  record: QuestionRecord,
): Promise<string> => {
  const path = questionRecordPath(root, record.questionId);
  const problem = questionRecordProblem(record);

  if (problem !== undefined) {
    throw new Error(problem);
  }

  await ensureTauDirectory(root, 'handoverQuestions');
  await writeRecord(path, record);

  return path;
};

export const deleteQuestionRecord = async (root: string, questionId: string): Promise<void> => {
  const path = questionRecordPath(root, questionId);

  await rejectTauSymlinks(root, 'handoverQuestions');

  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
};
