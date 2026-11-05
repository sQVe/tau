import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { serializeRecord } from '../../record.js';
import {
  answerByteLimit,
  answerPath,
  formatAnswerReference,
  parseAnswerReference,
  publishAnswer,
  readAnswer,
} from './answerRecord.js';
import type { AnswerRecord } from './answerRecord.js';
import { assignmentDirectory } from './assignment.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';
const questionId = '7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c';

const record: AnswerRecord = {
  version: 1,
  assignmentId,
  questionId,
  answeredAt: 1_900_000_000_000,
  answer: 'Use the v2 envelope.',
};

const useAssignmentDirectory = (): string => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-answer-');

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const directory = assignmentDirectory(assignmentId);

  mkdirSync(directory, { recursive: true, mode: 0o700 });

  return directory;
};

it('refuses a second answer for the same question and keeps the first bytes', () => {
  useAssignmentDirectory();

  const path = publishAnswer(record);
  const before = readFileSync(path);

  expect(() => publishAnswer({ ...record, answer: 'Another answer.' })).toThrow(
    /already has an answer/,
  );

  expect(path).toBe(answerPath(assignmentId, questionId));
  expect(readFileSync(path)).toEqual(before);
  expect(JSON.parse(before.toString('utf8'))).toEqual(record);
});

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/answer/${name}`, import.meta.url));

const snapshot = (directory: string) =>
  readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .toSorted()
    .map((name) => {
      const path = join(directory, name);
      const stats = lstatSync(path);

      return [name, stats.isFile() ? readFileSync(path, 'utf8') : stats.mode];
    });

const refusalOf = async (question: string, assignment = assignmentId): Promise<string> => {
  const read = await readAnswer(assignment, question);

  if (read.kind !== 'refused') {
    throw new Error(`Expected a refused answer, got ${read.kind}`);
  }

  return read.reason;
};

const writeAnswerFile = (directory: string, content: string): void => {
  mkdirSync(join(directory, 'answers'), { mode: 0o700 });
  writeFileSync(join(directory, 'answers', `${questionId}.json`), content);
};

it('saves the answer in a private folder and file', () => {
  const directory = useAssignmentDirectory();
  const path = publishAnswer(record);

  expect(statSync(join(directory, 'answers')).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

it.each([
  { case: 'current', fixture: 'current.json', read: { kind: 'answered', record } },
  { case: 'missing', fixture: undefined, read: { kind: 'unanswered' } },
])('reads a $case answer and changes no file', async ({ fixture, read }) => {
  const directory = useAssignmentDirectory();

  if (fixture !== undefined) {
    writeAnswerFile(directory, readFileSync(fixturePath(fixture), 'utf8'));
  }

  const before = snapshot(directory);

  await expect(readAnswer(assignmentId, questionId)).resolves.toEqual(read);
  expect(snapshot(directory)).toEqual(before);
});

it.each([
  { case: 'malformed', fixture: 'malformed.json', reason: /Malformed answer record/ },
  { case: 'unknown-field', fixture: 'unknown-field.json', reason: /Malformed answer record/ },
  { case: 'newer', fixture: 'newer.json', reason: /newer format/ },
])('refuses a $case answer and changes no file', async ({ fixture, reason }) => {
  const directory = useAssignmentDirectory();

  writeAnswerFile(directory, readFileSync(fixturePath(fixture), 'utf8'));

  const before = snapshot(directory);

  expect(await refusalOf(questionId)).toMatch(reason);
  expect(snapshot(directory)).toEqual(before);
});

it('refuses an answer saved for another question', async () => {
  const directory = useAssignmentDirectory();
  const otherQuestionId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

  writeAnswerFile(directory, serializeRecord({ ...record, questionId: otherQuestionId }));

  expect(await refusalOf(questionId)).toMatch(/names question/);
});

it('refuses an answer saved for another assignment', async () => {
  const directory = useAssignmentDirectory();
  const otherAssignmentId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

  writeAnswerFile(directory, serializeRecord({ ...record, assignmentId: otherAssignmentId }));

  expect(await refusalOf(questionId)).toMatch(/names assignment/);
});

it('refuses an assignment ID that is not a UUID before reading', async () => {
  useAssignmentDirectory();

  expect(await refusalOf(questionId, '../assignment')).toMatch(/Not an assignment ID/);
});

it('refuses a question ID that is not a UUID before reading', async () => {
  useAssignmentDirectory();

  expect(await refusalOf('../assignment')).toMatch(/Not a question ID/);
});

it('publishes an answer at the byte limit', async () => {
  useAssignmentDirectory();
  publishAnswer({ ...record, answer: 'é'.repeat(answerByteLimit / 2) });

  await expect(readAnswer(assignmentId, questionId)).resolves.toMatchObject({ kind: 'answered' });
});

it('refuses to publish an answer over the byte limit and writes nothing', () => {
  const directory = useAssignmentDirectory();

  expect(() => publishAnswer({ ...record, answer: `${'é'.repeat(answerByteLimit / 2)}a` })).toThrow(
    /larger than/,
  );

  expect(snapshot(directory)).toEqual([]);
});

it('refuses to read a saved answer over the byte limit', async () => {
  const directory = useAssignmentDirectory();

  writeAnswerFile(
    directory,
    serializeRecord({ ...record, answer: 'a'.repeat(answerByteLimit + 1) }),
  );

  expect(await refusalOf(questionId)).toMatch(/answer is larger than/);
});

it('reads an answer at the byte limit of escaped characters', async () => {
  const directory = useAssignmentDirectory();

  writeAnswerFile(
    directory,
    serializeRecord({ ...record, answer: '\u0000'.repeat(answerByteLimit) }),
  );

  await expect(readAnswer(assignmentId, questionId)).resolves.toMatchObject({ kind: 'answered' });
});

it('refuses to read an answer file over the record size limit', async () => {
  const directory = useAssignmentDirectory();
  const padding = ' '.repeat(answerByteLimit * 7);

  writeAnswerFile(directory, `${serializeRecord(record)}${padding}`);

  expect(await refusalOf(questionId)).toMatch(/larger than \d+ bytes/);
});

it('refuses to publish an answer with a question ID that is not a UUID and writes nothing', () => {
  const directory = useAssignmentDirectory();

  expect(() => publishAnswer({ ...record, questionId: '../assignment' })).toThrow(
    /Malformed answer/,
  );

  expect(snapshot(directory)).toEqual([]);
});

it('refuses to publish for an assignment without a folder and creates nothing', () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-answer-');

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  expect(() => publishAnswer(record)).toThrow(/ENOENT/);
  expect(snapshot(agentDirectory)).toEqual([]);
});

it('refuses to publish when the answers path is a file and keeps the file', () => {
  const directory = useAssignmentDirectory();

  writeFileSync(join(directory, 'answers'), 'not a folder');

  expect(() => publishAnswer(record)).toThrow(/ENOTDIR/);
  expect(readFileSync(join(directory, 'answers'), 'utf8')).toBe('not a folder');
});

it('reports a failed write without calling it an existing answer', () => {
  const directory = useAssignmentDirectory();

  mkdirSync(join(directory, 'answers'), { mode: 0o500 });

  const caught = (() => {
    try {
      publishAnswer(record);
    } catch (error) {
      return error;
    }

    return undefined;
  })();

  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).not.toMatch(/already has an answer/);
  expect(readdirSync(join(directory, 'answers'))).toEqual([]);
});

it('refuses to publish through a symlinked answers folder and writes nothing', () => {
  const directory = useAssignmentDirectory();
  const target = temporaryDirectory(onTestFinished, 'tau-answer-target-');

  symlinkSync(target, join(directory, 'answers'), 'dir');

  expect(() => publishAnswer(record)).toThrow(/symlink/);
  expect(readdirSync(target)).toEqual([]);
});

it('refuses to read through a symlinked answers folder', async () => {
  const directory = useAssignmentDirectory();
  const target = temporaryDirectory(onTestFinished, 'tau-answer-target-');

  writeFileSync(join(target, `${questionId}.json`), serializeRecord(record));
  symlinkSync(target, join(directory, 'answers'), 'dir');

  expect(await refusalOf(questionId)).toMatch(/Refusing to read answer record through a symlink/);
});

const linkAssignmentDirectory = (): string => {
  const directory = useAssignmentDirectory();
  const target = temporaryDirectory(onTestFinished, 'tau-answer-target-');

  rmSync(directory, { recursive: true });
  symlinkSync(target, directory, 'dir');

  return target;
};

it('refuses to publish through a symlinked assignment folder and writes nothing', () => {
  const target = linkAssignmentDirectory();

  expect(() => publishAnswer(record)).toThrow(/symlink/);
  expect(readdirSync(target)).toEqual([]);
});

it('refuses to read through a symlinked assignment folder', async () => {
  const target = linkAssignmentDirectory();

  mkdirSync(join(target, 'answers'));
  writeFileSync(join(target, 'answers', `${questionId}.json`), serializeRecord(record));

  expect(await refusalOf(questionId)).toMatch(/symlinked approved directory/);
});

it('parses the reference it formats', () => {
  useAssignmentDirectory();

  expect(parseAnswerReference(formatAnswerReference(assignmentId, questionId))).toEqual({
    assignmentId,
    questionId,
    answerPath: answerPath(assignmentId, questionId),
  });
});

it.each([
  { case: 'text that is not JSON', text: 'answer', reason: /not JSON/ },
  {
    case: 'an unknown field',
    text: JSON.stringify({ assignmentId, questionId, answerPath: '/a', answer: 'text' }),
    reason: /Malformed answer reference/,
  },
  {
    case: 'an ID that is not a UUID',
    text: JSON.stringify({ assignmentId, questionId: '..', answerPath: '/a' }),
    reason: /Malformed answer reference/,
  },
  {
    case: 'a path that is not the canonical answer path',
    text: JSON.stringify({ assignmentId, questionId, answerPath: '/tmp/answer.json' }),
    reason: /not \//,
  },
])('refuses a reference with $case', ({ text, reason }) => {
  useAssignmentDirectory();

  expect(() => parseAnswerReference(text)).toThrow(reason);
});
