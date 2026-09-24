import { closeSync, fsyncSync, openSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { Value } from 'typebox/value';

import { hasErrorCode } from '../../errors/index.js';
import { publish, readOptionalRecord, readRecord, readTask } from './records.js';
import {
  acknowledgementSchema,
  questionIdentitySchema,
  questionSchema,
  replySchema,
} from './types.js';
import type { Acknowledgement, Question, Reply } from './types.js';

const questionRecordName = (
  questionId: string,
  kind: 'question' | 'reply' | 'acknowledgement',
): string => {
  if (!Value.Check(questionIdentitySchema, questionId)) {
    throw new Error('Invalid question identity or wrong saved task.');
  }

  return `${kind}-${questionId}.json`;
};

// Check the saved task once per public call. Nested record reads would otherwise re-read task.json.
const requireSavedTask = (directory: string, taskId: string): void => {
  if (readTask(directory).taskId !== taskId) {
    throw new Error('Invalid question identity or wrong saved task.');
  }
};

const publishQuestionRecord = (
  directory: string,
  name: string,
  value: Question | Reply | Acknowledgement,
): void => {
  if (Buffer.byteLength(JSON.stringify(value)) > 64_000) {
    throw new Error('Question record exceeds 64 KB.');
  }

  try {
    publish(directory, name, value);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }

    // Recovery may repeat the same identity, but cannot replace any accepted content.
    if (!isDeepStrictEqual(readRecord(directory, name), value)) {
      throw new Error('Conflicting saved question record.', { cause: error });
    }

    // A prior publication may have linked the record but failed to sync the directory.
    const directoryDescriptor = openSync(directory, 'r');

    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
};

const questionMatchesIdentity = (question: Question, taskId: string, questionId: string): boolean =>
  question.taskId === taskId &&
  question.questionId === questionId &&
  Buffer.byteLength(JSON.stringify(question)) <= 64_000;

const savedQuestion = (
  directory: string,
  taskId: string,
  questionId: string,
): Question | undefined => {
  const value = readOptionalRecord(directory, questionRecordName(questionId, 'question'));

  if (value === undefined) {
    return undefined;
  }

  if (!Value.Check(questionSchema, value) || !questionMatchesIdentity(value, taskId, questionId)) {
    throw new Error('Invalid saved worker question.');
  }

  return value;
};

export const readQuestion = (
  directory: string,
  taskId: string,
  questionId: string,
): Question | undefined => {
  questionRecordName(questionId, 'question');
  requireSavedTask(directory, taskId);

  return savedQuestion(directory, taskId, questionId);
};

export const validateQuestion = (value: unknown, taskId: string): Question => {
  if (!Value.Check(questionSchema, value) || value.taskId !== taskId) {
    throw new Error('Invalid or wrong-task question.');
  }

  if (Buffer.byteLength(JSON.stringify(value)) > 64_000) {
    throw new Error('Question record exceeds 64 KB.');
  }

  return value;
};

export const acceptQuestion = (directory: string, taskId: string, value: unknown): Question => {
  const question = validateQuestion(value, taskId);
  const name = questionRecordName(question.questionId, 'question');

  requireSavedTask(directory, taskId);

  publishQuestionRecord(directory, name, question);

  return question;
};

const replyMatchesIdentity = (reply: Reply, taskId: string, questionId: string): boolean =>
  reply.taskId === taskId &&
  reply.questionId === questionId &&
  Buffer.byteLength(JSON.stringify(reply)) <= 64_000;

const savedReply = (directory: string, taskId: string, questionId: string): Reply | undefined => {
  const name = questionRecordName(questionId, 'reply');
  const question = savedQuestion(directory, taskId, questionId);
  const value = readOptionalRecord(directory, name);

  if (value === undefined) {
    return undefined;
  }

  if (
    !question ||
    !Value.Check(replySchema, value) ||
    !replyMatchesIdentity(value, taskId, questionId)
  ) {
    throw new Error('Invalid saved worker reply.');
  }

  return value;
};

export const readReply = (
  directory: string,
  taskId: string,
  questionId: string,
): Reply | undefined => {
  questionRecordName(questionId, 'reply');
  requireSavedTask(directory, taskId);

  return savedReply(directory, taskId, questionId);
};

export const acceptReply = (directory: string, taskId: string, value: unknown): Reply => {
  if (!Value.Check(replySchema, value) || value.taskId !== taskId) {
    throw new Error('Invalid or wrong-task reply.');
  }

  const name = questionRecordName(value.questionId, 'reply');

  requireSavedTask(directory, taskId);

  if (!savedQuestion(directory, taskId, value.questionId)) {
    throw new Error('Reply has no accepted question.');
  }

  publishQuestionRecord(directory, name, value);

  return value;
};

const acknowledgementMatchesReply = (
  acknowledgement: Acknowledgement,
  reply: Reply,
  taskId: string,
  questionId: string,
): boolean =>
  acknowledgement.taskId === taskId &&
  acknowledgement.questionId === questionId &&
  acknowledgement.replyId === reply.replyId;

const savedAcknowledgement = (
  directory: string,
  taskId: string,
  questionId: string,
): Acknowledgement | undefined => {
  const name = questionRecordName(questionId, 'acknowledgement');
  const reply = savedReply(directory, taskId, questionId);
  const value = readOptionalRecord(directory, name);

  if (value === undefined) {
    return undefined;
  }

  if (
    !reply ||
    !Value.Check(acknowledgementSchema, value) ||
    !acknowledgementMatchesReply(value, reply, taskId, questionId)
  ) {
    throw new Error('Invalid saved worker acknowledgement.');
  }

  return value;
};

export const readAcknowledgement = (
  directory: string,
  taskId: string,
  questionId: string,
): Acknowledgement | undefined => {
  questionRecordName(questionId, 'acknowledgement');
  requireSavedTask(directory, taskId);

  return savedAcknowledgement(directory, taskId, questionId);
};

export const acceptAcknowledgement = (
  directory: string,
  taskId: string,
  value: unknown,
): Acknowledgement => {
  if (!Value.Check(acknowledgementSchema, value) || value.taskId !== taskId) {
    throw new Error('Invalid or wrong-task acknowledgement.');
  }

  const name = questionRecordName(value.questionId, 'acknowledgement');

  requireSavedTask(directory, taskId);
  const reply = savedReply(directory, taskId, value.questionId);

  if (!reply || value.replyId !== reply.replyId) {
    throw new Error('Acknowledgement does not match the accepted reply.');
  }

  publishQuestionRecord(directory, name, value);

  return value;
};

export const readPendingQuestion = (directory: string, taskId: string): Question | undefined => {
  requireSavedTask(directory, taskId);
  let pending: Question | undefined;

  for (const name of readdirSync(directory)) {
    if (!name.startsWith('question-') || !name.endsWith('.json')) {
      continue;
    }

    const questionId = name.slice('question-'.length, -'.json'.length);
    const question = savedQuestion(directory, taskId, questionId);

    if (!savedAcknowledgement(directory, taskId, questionId)) {
      if (pending) {
        throw new Error('Multiple pending worker questions.');
      }

      pending = question;
    }
  }

  return pending;
};
