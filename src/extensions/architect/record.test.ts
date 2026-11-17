import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import {
  architectRecordPath,
  readArchitectRecord,
  readAskRecord,
  readAskRecords,
  readGateRecord,
  writeArchitectRecord,
  writeAskRecord,
  writeGateRecord,
} from './record.js';

const architectRecord = {
  version: 1,
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-architect',
  leadTerminal: 't-lead',
  updatedAt: '2026-11-17T10:00:00.000Z',
} as const;

it('reads a version 1 architect record it wrote', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeArchitectRecord(root, architectRecord);

  expect(await readArchitectRecord(root)).toEqual(architectRecord);
});

it('reads a missing architect record as undefined', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  expect(await readArchitectRecord(root)).toBeUndefined();
});

it('refuses a malformed architect record', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const path = architectRecordPath(root);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{"version":1,"sessionFile":3}');

  await expect(readArchitectRecord(root)).rejects.toThrow(`Malformed architect record ${path}`);
});

it('writes one gate record per call and reads it back', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const record = {
    version: 1,
    createdAt: '2026-11-17T10:00:00.000Z',
    request: 'Rename the flag.',
    restatement: 'Rename --fast to --quick.',
    outcome: { kind: 'answered', label: 'specified', confidence: 0.9 },
    decision: 'specified',
    label: 'specified',
    confidence: 0.9,
  } as const;

  const first = await writeGateRecord(root, record);
  const second = await writeGateRecord(root, record);

  expect(first).not.toBe(second);
  expect(await readGateRecord(root, basename(first))).toEqual(record);
  expect(await readGateRecord(root, basename(second))).toEqual(record);
});

it('lists ask records oldest first and reads one by id', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const base = {
    version: 1,
    question: 'Which flag name?',
    sessionFile: '/sessions/architect.jsonl',
    terminal: 't-ask',
    leadTerminal: 't-lead',
    deadline: 1,
    status: 'sent',
    detail: null,
    answer: 'Use --quick.',
  } as const;

  const later = { ...base, askId: 'b', createdAt: '2026-11-17T10:00:01.000Z' } as const;
  const earlier = { ...base, askId: 'a', createdAt: '2026-11-17T10:00:00.000Z' } as const;

  await writeAskRecord(root, later);
  await writeAskRecord(root, earlier);

  expect((await readAskRecords(root)).map((record) => record.askId)).toEqual(['a', 'b']);
  expect(await readAskRecord(root, 'b')).toEqual(later);
  expect(await readAskRecord(root, 'missing')).toBeUndefined();
});

it('lists no ask records before the directory exists', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  expect(await readAskRecords(root)).toEqual([]);
  expect(await readAskRecord(root, 'missing')).toBeUndefined();
});
