import { existsSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.ts';
import { ensureTauDirectory } from '../../tauDirectory.ts';
import {
  deleteQuestionRecord,
  questionRecordDirectory,
  readQuestionRecord,
  writeQuestionRecord,
} from './questionRecord.ts';
import type { QuestionRecord } from './questionRecord.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  const cleanupTasks = cleanups.splice(0).map((cleanup) => cleanup());
  await Promise.all(cleanupTasks);
});

const createProject = () => createTemporaryRepository((cleanup) => cleanups.push(cleanup));

const questionId = '11111111-1111-4111-8111-111111111111';

const fixture = (name: string): string =>
  join(import.meta.dirname, 'fixtures', 'questionRecord', name);

const copyFixture = async (root: string, name: string): Promise<string> => {
  const directory = await ensureTauDirectory(root, 'handoverQuestions');
  const path = join(directory, `${questionId}.json`);

  await copyFile(fixture(name), path);

  return path;
};

const currentRecord = (): QuestionRecord => ({
  version: 1,
  questionId,
  askerTerminal: 'worker',
  askerSession: '22222222-2222-4222-8222-222222222222',
  senderTerminal: 'lead',
  senderSession: '33333333-3333-4333-8333-333333333333',
  text: 'Which option should I use?',
  askedAt: '2026-11-18T12:00:00.000Z',
  state: 'open',
  answer: null,
});

it('reads the frozen current record', async () => {
  const root = await createProject();

  await copyFixture(root, 'current.json');

  expect(await readQuestionRecord(root, questionId)).toEqual({
    kind: 'record',
    record: currentRecord(),
  });
});

it.each(['newer.json', 'malformed.json'])('reads %s as malformed with a reason', async (name) => {
  const root = await createProject();

  await copyFixture(root, name);

  const read = await readQuestionRecord(root, questionId);
  const reason = read.kind === 'malformed' ? read.reason : '';

  expect(read.kind).toBe('malformed');
  expect(reason.length).toBeGreaterThan(0);
});

it('reads a missing record as missing', async () => {
  const root = await createProject();

  expect(await readQuestionRecord(root, questionId)).toEqual({ kind: 'missing' });
});

it('writes a record, reads it back, and deletes it', async () => {
  const root = await createProject();
  const record = currentRecord();

  const path = await writeQuestionRecord(root, record);

  expect(path).toBe(join(questionRecordDirectory(root), `${questionId}.json`));
  expect(await readQuestionRecord(root, questionId)).toEqual({ kind: 'record', record });

  await deleteQuestionRecord(root, questionId);
  expect(await readQuestionRecord(root, questionId)).toEqual({ kind: 'missing' });

  await expect(deleteQuestionRecord(root, questionId)).resolves.toBeUndefined();
});

it('reads an open record with an answer as malformed', async () => {
  const root = await createProject();
  const directory = await ensureTauDirectory(root, 'handoverQuestions');

  await writeFile(
    join(directory, `${questionId}.json`),
    JSON.stringify({ ...currentRecord(), answer: 'Use the first option.' }),
  );

  const read = await readQuestionRecord(root, questionId);
  const reason = read.kind === 'malformed' ? read.reason : '';

  expect(read.kind).toBe('malformed');
  expect(reason.length).toBeGreaterThan(0);
});

it('reads a question ID that is not a UUID as malformed without touching the disk', async () => {
  const root = await createProject();

  expect(await readQuestionRecord(root, 'not-a-uuid')).toMatchObject({ kind: 'malformed' });
  expect(existsSync(questionRecordDirectory(root))).toBe(false);
});
