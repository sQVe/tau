import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.ts';
import { ensureTauDirectory } from '../../../tauDirectory.ts';
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

const linkParentDirectory = async (root: string): Promise<string> => {
  const directory = await ensureTauDirectory(root, 'handoverQuestions');
  const outside = join(root, 'outside');
  const path = join(outside, `${questionId}.json`);

  await mkdir(outside);
  await copyFile(fixture('current.json'), path);
  await rm(directory, { recursive: true });
  await symlink(outside, directory, 'dir');

  return path;
};

const linkRecordFile = async (root: string): Promise<string> => {
  const directory = await ensureTauDirectory(root, 'handoverQuestions');
  const outside = join(root, 'outside.json');

  await copyFile(fixture('current.json'), outside);
  await symlink(outside, join(directory, `${questionId}.json`), 'file');

  return outside;
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
  const path = await copyFixture(root, 'current.json');
  const before = await readFile(path);

  expect(await readQuestionRecord(root, questionId)).toEqual({
    kind: 'record',
    record: currentRecord(),
  });

  expect(await readFile(path)).toEqual(before);
});

it.each(['newer.json', 'malformed.json'])('reads %s as malformed with a reason', async (name) => {
  const root = await createProject();
  const path = await copyFixture(root, name);
  const before = await readFile(path);

  const read = await readQuestionRecord(root, questionId);
  const reason = read.kind === 'malformed' ? read.reason : '';

  expect(read.kind).toBe('malformed');
  expect(reason.length).toBeGreaterThan(0);
  expect(await readFile(path)).toEqual(before);
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

  expect(existsSync(path)).toBe(true);

  await deleteQuestionRecord(root, questionId);

  expect(existsSync(path)).toBe(false);
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

it('reads through a linked parent directory as malformed', async () => {
  const root = await createProject();
  const outsidePath = await linkParentDirectory(root);
  const before = await readFile(outsidePath);

  const read = await readQuestionRecord(root, questionId);
  const reason = read.kind === 'malformed' ? read.reason : '';

  expect(read.kind).toBe('malformed');
  expect(reason.length).toBeGreaterThan(0);
  expect(await readFile(outsidePath)).toEqual(before);
});

it('reads through a linked record file as malformed', async () => {
  const root = await createProject();
  const outsidePath = await linkRecordFile(root);
  const before = await readFile(outsidePath);

  const read = await readQuestionRecord(root, questionId);
  const reason = read.kind === 'malformed' ? read.reason : '';

  expect(read.kind).toBe('malformed');
  expect(reason.length).toBeGreaterThan(0);
  expect(await readFile(outsidePath)).toEqual(before);
});

it('refuses to delete through a linked parent directory', async () => {
  const root = await createProject();
  const outsidePath = await linkParentDirectory(root);

  await expect(deleteQuestionRecord(root, questionId)).rejects.toBeInstanceOf(Error);

  expect(existsSync(outsidePath)).toBe(true);
});

it('refuses a record that fails the schema and keeps the existing record', async () => {
  const root = await createProject();
  const path = await writeQuestionRecord(root, currentRecord());
  const before = await readFile(path);

  await expect(writeQuestionRecord(root, { ...currentRecord(), text: '' })).rejects.toBeInstanceOf(
    Error,
  );

  expect(await readFile(path)).toEqual(before);
});

it('refuses a record whose askedAt is not a UTC ISO timestamp and saves nothing', async () => {
  const root = await createProject();

  await expect(
    writeQuestionRecord(root, { ...currentRecord(), askedAt: 'not a timestamp' }),
  ).rejects.toBeInstanceOf(Error);

  expect(existsSync(questionRecordDirectory(root))).toBe(false);
});

it.each(['2026-99-99T99:99:99Z', '2026-02-30T00:00:00Z'])(
  'refuses a record whose askedAt is %s and saves nothing',
  async (askedAt) => {
    const root = await createProject();

    await expect(writeQuestionRecord(root, { ...currentRecord(), askedAt })).rejects.toBeInstanceOf(
      Error,
    );

    expect(existsSync(questionRecordDirectory(root))).toBe(false);
  },
);

it('reads a record whose question ID differs from the requested ID as malformed', async () => {
  const root = await createProject();
  const directory = await ensureTauDirectory(root, 'handoverQuestions');
  const path = join(directory, `${questionId}.json`);
  const otherId = '44444444-4444-4444-8444-444444444444';

  await writeFile(path, JSON.stringify({ ...currentRecord(), questionId: otherId }));
  const before = await readFile(path);

  const read = await readQuestionRecord(root, questionId);
  const reason = read.kind === 'malformed' ? read.reason : '';

  expect(read.kind).toBe('malformed');
  expect(reason.length).toBeGreaterThan(0);
  expect(await readFile(path)).toEqual(before);
});

it('reads a record whose askedAt is not a UTC ISO timestamp as malformed', async () => {
  const root = await createProject();
  const directory = await ensureTauDirectory(root, 'handoverQuestions');
  const path = join(directory, `${questionId}.json`);

  await writeFile(path, JSON.stringify({ ...currentRecord(), askedAt: 'not a timestamp' }));
  const before = await readFile(path);

  const read = await readQuestionRecord(root, questionId);
  const reason = read.kind === 'malformed' ? read.reason : '';

  expect(read.kind).toBe('malformed');
  expect(reason.length).toBeGreaterThan(0);
  expect(await readFile(path)).toEqual(before);
});

it.each(['2026-99-99T99:99:99Z', '2026-02-30T00:00:00Z'])(
  'reads a record whose askedAt is %s as malformed',
  async (askedAt) => {
    const root = await createProject();
    const directory = await ensureTauDirectory(root, 'handoverQuestions');
    const path = join(directory, `${questionId}.json`);

    await writeFile(path, JSON.stringify({ ...currentRecord(), askedAt }));
    const before = await readFile(path);

    const read = await readQuestionRecord(root, questionId);
    const reason = read.kind === 'malformed' ? read.reason : '';

    expect(read.kind).toBe('malformed');
    expect(reason.length).toBeGreaterThan(0);
    expect(await readFile(path)).toEqual(before);
  },
);

it.each([
  ['empty asker terminal', { askerTerminal: '' }],
  ['empty sender terminal', { senderTerminal: '' }],
  ['malformed asker session', { askerSession: 'not a session!' }],
  ['malformed sender session', { senderSession: '' }],
])('reads a record with %s as malformed', async (_label, overrides) => {
  const root = await createProject();
  const directory = await ensureTauDirectory(root, 'handoverQuestions');
  const path = join(directory, `${questionId}.json`);

  await writeFile(path, JSON.stringify({ ...currentRecord(), ...overrides }));
  const before = await readFile(path);

  const read = await readQuestionRecord(root, questionId);
  const reason = read.kind === 'malformed' ? read.reason : '';

  expect(read.kind).toBe('malformed');
  expect(reason.length).toBeGreaterThan(0);
  expect(await readFile(path)).toEqual(before);
});

it('reads a question ID that is not a UUID as malformed without touching the disk', async () => {
  const root = await createProject();

  expect(await readQuestionRecord(root, 'not-a-uuid')).toMatchObject({ kind: 'malformed' });
  expect(existsSync(questionRecordDirectory(root))).toBe(false);
});

it('refuses to write or delete a record with a question ID that is not a UUID', async () => {
  const root = await createProject();
  const escapingId = '../../outside';

  await expect(
    writeQuestionRecord(root, { ...currentRecord(), questionId: escapingId }),
  ).rejects.toBeInstanceOf(Error);

  await expect(deleteQuestionRecord(root, escapingId)).rejects.toBeInstanceOf(Error);

  expect(existsSync(questionRecordDirectory(root))).toBe(false);
  expect(existsSync(join(root, 'outside.json'))).toBe(false);
});
