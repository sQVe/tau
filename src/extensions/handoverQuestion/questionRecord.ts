import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage, isMissingFile } from '../../errors.js';
import { isUuid, uuidSchema } from '../../inbox/inbox.js';
import { readVersionedRecord, writeRecord } from '../../record.js';
import { ensureTauDirectory } from '../../tauDirectory.js';

export type QuestionRead =
  | { kind: 'record'; record: QuestionRecord }
  | { kind: 'missing' }
  | { kind: 'malformed'; reason: string };

const questionRecordVersion = 1;

const strict = { additionalProperties: false } as const;

const questionFields = {
  version: Type.Literal(questionRecordVersion),
  questionId: uuidSchema,
  askerTerminal: Type.String(),
  askerSession: Type.String(),
  senderTerminal: Type.String(),
  senderSession: Type.String(),
  text: Type.String({ minLength: 1, maxLength: 4000 }),
  askedAt: Type.String(),
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

  try {
    const record = await readVersionedRecord(questionRecordPath(root, questionId), {
      label: 'handover question record',
      version: questionRecordVersion,
      schema: questionRecordSchema,
    });

    return record === undefined ? { kind: 'missing' } : { kind: 'record', record };
  } catch (error) {
    return { kind: 'malformed', reason: errorMessage(error) };
  }
};

export const writeQuestionRecord = async (
  root: string,
  record: QuestionRecord,
): Promise<string> => {
  const path = questionRecordPath(root, record.questionId);

  await ensureTauDirectory(root, 'handoverQuestions');
  await writeRecord(path, record);

  return path;
};

export const deleteQuestionRecord = async (root: string, questionId: string): Promise<void> => {
  const path = questionRecordPath(root, questionId);

  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
};
