import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Value } from 'typebox/value';

import {
  acknowledgementSchema,
  eventSchema,
  questionIdentitySchema,
  questionSchema,
  replySchema,
  reportSchema,
  taskSchema,
  successorSchema,
} from './types.js';
import type {
  Acknowledgement,
  Question,
  Reply,
  Report,
  Successor,
  Task,
  TaskEvent,
} from './types.js';

const recordByteLimit = 128_000;

const serializeRecord = (value: unknown): string => {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > recordByteLimit) {
    throw new Error('Worker record exceeds 128 KB.');
  }

  return serialized;
};

// Publish complete files without replacing an accepted record. This is not protection from trusted workers editing files directly.
export const publish = (directory: string, name: string, value: unknown): void => {
  const serialized = serializeRecord(value);
  const temporary = join(directory, `.receipt-${randomUUID()}`);
  const descriptor = openSync(temporary, 'wx', 0o600);

  try {
    writeFileSync(descriptor, serialized);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  try {
    linkSync(temporary, join(directory, name));
    const directoryDescriptor = openSync(directory, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    unlinkSync(temporary);
  }
};

export const readRecord = (directory: string, name: string): unknown => {
  const descriptor = openSync(join(directory, name), 'r');
  try {
    const buffer = Buffer.alloc(recordByteLimit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = readSync(descriptor, buffer, {
        offset: bytesRead,
        length: buffer.length - bytesRead,
        position: bytesRead,
      });
      if (read === 0) {
        break;
      }
      bytesRead += read;
    }

    if (bytesRead > recordByteLimit) {
      throw new Error('Worker record exceeds 128 KB.');
    }

    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    closeSync(descriptor);
  }
};

export const validateTask = (value: unknown): Task => {
  if (!Value.Check(taskSchema, value)) {
    throw new Error('Invalid saved worker task or loadout.');
  }
  serializeRecord(value);

  if (
    value.deadline <= value.createdAt + value.cancellationBudget ||
    value.deadline - value.createdAt > 2_147_483_647
  ) {
    throw new Error('Invalid fixed worker deadline.');
  }
  if (
    ![
      value.nativeSessionFile,
      value.parentSession,
      value.loadout.cwd,
      value.loadout.agentDirectory,
      value.loadout.safetyExtension,
      ...value.loadout.integrations,
    ].every(isAbsolute)
  ) {
    throw new Error('Worker paths must be absolute.');
  }
  if (
    (value.name !== undefined &&
      !value.name.startsWith(value.loadout.role === 'editing' ? 'worker-' : 'investigator-')) ||
    value.predecessorTaskId === value.taskId ||
    value.taskId === value.nativeSessionId ||
    !value.loadout.integrations.includes(value.loadout.safetyExtension)
  ) {
    throw new Error('Invalid worker identity or missing safety integration.');
  }
  if (
    !['read', 'bash', 'edit', 'write', 'subagent_report'].every((tool) =>
      value.loadout.tools.includes(tool),
    )
  ) {
    throw new Error('A trusted worker requires the coding and report tools.');
  }

  return value;
};

export const readTask = (directory: string): Task => {
  return validateTask(readRecord(directory, 'task.json'));
};

export const readSuccessor = (directory: string): Successor | undefined => {
  let value: unknown;
  try {
    value = readRecord(directory, 'successor.json');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const task = readTask(directory);
  if (
    !Value.Check(successorSchema, value) ||
    value.predecessorTaskId !== task.taskId ||
    value.successorTaskId === task.taskId ||
    value.nativeSessionId !== task.nativeSessionId ||
    value.nativeSessionFile !== task.nativeSessionFile
  ) {
    throw new Error('Invalid saved successor claim.');
  }

  return value;
};

const isUnpublishedDirectory = (directory: string): boolean =>
  readdirSync(directory, { withFileTypes: true }).every(
    (entry) => entry.isFile() && /^\.receipt-[a-f0-9-]+$/.test(entry.name),
  );

const readScannedTask = (directory: string): Task | undefined => {
  try {
    return readTask(directory);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  // Another process may publish the task after the failed read. A dangling link still fails.
  if (
    lstatSync(join(directory, 'task.json'), { throwIfNoEntry: false }) ||
    !isUnpublishedDirectory(directory)
  ) {
    return readTask(directory);
  }

  return undefined;
};

export const readTasks = (
  root: string,
  diagnostics: string[] = [],
): { directory: string; task: Task }[] => {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const tasks: { directory: string; task: Task }[] = [];
  const unpublished = new Map<string, string>();
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const directory = join(root, entry.name);
    const task = readScannedTask(directory);
    if (!task) {
      unpublished.set(entry.name, directory);
      continue;
    }
    if (task.taskId !== entry.name) {
      throw new Error('Saved task directory and identity do not match.');
    }
    tasks.push({ directory, task });
  }

  if (unpublished.size) {
    for (const { directory, task } of tasks) {
      const referenced = [task.predecessorTaskId, readSuccessor(directory)?.successorTaskId].find(
        (id) => id !== undefined && unpublished.has(id),
      );
      if (referenced) {
        throw new Error(
          `Missing task.json for referenced continuation ${referenced}. Saved attempt or claim requires inspection.`,
        );
      }
    }
  }
  for (const [id, directory] of unpublished) {
    diagnostics.push(
      `Skipped unpublished task ${id}; preparation evidence remains at ${directory}.`,
    );
  }

  return tasks;
};

export const claimSuccessor = (directory: string, successor: Task): void => {
  const predecessor = readTask(directory);
  const existing = readSuccessor(directory);
  if (existing) {
    throw new Error(
      `Task ${predecessor.taskId} already claimed by successor ${existing.successorTaskId}. No retry.`,
    );
  }
  if (
    successor.predecessorTaskId !== predecessor.taskId ||
    successor.taskId === predecessor.taskId ||
    successor.nativeSessionId !== predecessor.nativeSessionId ||
    successor.nativeSessionFile !== predecessor.nativeSessionFile
  ) {
    throw new Error('Successor identity does not match its predecessor.');
  }

  try {
    publish(directory, 'successor.json', {
      version: 1,
      predecessorTaskId: predecessor.taskId,
      successorTaskId: successor.taskId,
      nativeSessionId: successor.nativeSessionId,
      nativeSessionFile: successor.nativeSessionFile,
    });
  } catch (error) {
    throw new Error(
      `Claim for successor ${successor.taskId} is uncertain or another successor won. Inspect successor.json; never retry or reclaim by age.`,
      { cause: error },
    );
  }
};

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

const readOptionalRecord = (directory: string, name: string): unknown => {
  try {
    return readRecord(directory, name);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
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
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
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

const savedQuestion = (
  directory: string,
  taskId: string,
  questionId: string,
): Question | undefined => {
  const value = readOptionalRecord(directory, questionRecordName(questionId, 'question'));
  if (value === undefined) {
    return undefined;
  }
  if (
    !Value.Check(questionSchema, value) ||
    value.taskId !== taskId ||
    value.questionId !== questionId ||
    Buffer.byteLength(JSON.stringify(value)) > 64_000
  ) {
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
    value.taskId !== taskId ||
    value.questionId !== questionId ||
    Buffer.byteLength(JSON.stringify(value)) > 64_000
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
    value.taskId !== taskId ||
    value.questionId !== questionId ||
    value.replyId !== reply.replyId
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

const validReport = (value: unknown, taskId: string): value is Report =>
  Value.Check(reportSchema, value) &&
  value.taskId === taskId &&
  Buffer.byteLength(JSON.stringify(value)) <= 64_000;

export const acceptReport = (directory: string, taskId: string, value: unknown): Report => {
  if (!validReport(value, taskId)) {
    throw new Error('Invalid, oversized, or wrong-task report.');
  }

  publish(directory, 'report.json', value);

  return value;
};

export const readReport = (directory: string, taskId: string): Report | undefined => {
  try {
    const value = readRecord(directory, 'report.json');
    if (!validReport(value, taskId)) {
      throw new Error('Invalid saved worker report.');
    }

    return value;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

export const recordEvent = (
  directory: string,
  taskId: string,
  kind: TaskEvent['kind'],
  detail: string,
  stopped = false,
  processId?: number,
): void => {
  publish(directory, `${kind}.json`, {
    taskId,
    kind,
    detail,
    stopped,
    at: Date.now(),
    ...(processId === undefined ? {} : { processId }),
  });
};

export const readEvent = (
  directory: string,
  taskId: string,
  kind: TaskEvent['kind'],
): TaskEvent | undefined => {
  try {
    const value = readRecord(directory, `${kind}.json`);
    if (!Value.Check(eventSchema, value) || value.taskId !== taskId || value.kind !== kind) {
      throw new Error('Invalid worker lifecycle record.');
    }

    return value;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};
