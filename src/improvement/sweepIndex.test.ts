import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { isMissingFile } from '../errors.ts';
import { readSweepIndex, sweepIndexPath, writeSweepIndex } from './sweepIndex.ts';
import type { SweepIndex } from './sweepIndex.ts';

const fixturePath = join(import.meta.dirname, 'fixtures', 'sweep-index-v1.json');

const readFixture = async (): Promise<SweepIndex> => {
  const source = await readFile(fixturePath, 'utf8');

  return JSON.parse(source) as SweepIndex;
};

const writeIndexText = async (agentDirectory: string, text: string) => {
  const path = sweepIndexPath(agentDirectory);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

const directoryState = async (agentDirectory: string) => {
  const names = await readdir(agentDirectory);

  const bytes = await readFile(sweepIndexPath(agentDirectory), 'utf8').catch((error: unknown) => {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  });

  return { names, bytes };
};

it('reads a saved index', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-sweep-index-');
  const fixture = await readFixture();
  await writeIndexText(agentDirectory, JSON.stringify(fixture));

  expect(await readSweepIndex(agentDirectory)).toEqual({ status: 'read', index: fixture });

  const lastSweeps: SweepIndex['lastSweep'][] = [
    null,
    { startedAt: '2026-11-15T12:00:00.000Z', outcome: 'caughtUp' },
    { startedAt: '2026-11-15T12:00:00.000Z', outcome: 'failed', reason: 'gh failed' },
  ];

  for (const lastSweep of lastSweeps) {
    const index = { ...fixture, lastSweep };
    await writeIndexText(agentDirectory, JSON.stringify(index));

    expect(await readSweepIndex(agentDirectory)).toEqual({ status: 'read', index });
  }
});

it('reads a missing index as missing', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-sweep-index-');
  const before = await directoryState(agentDirectory);

  expect(await readSweepIndex(agentDirectory)).toEqual({ status: 'missing' });
  expect(await directoryState(agentDirectory)).toEqual(before);
});

it.each([
  { rule: 'not JSON', text: '{' },
  {
    rule: 'a version 1 record failing the schema',
    text: JSON.stringify({
      version: 1,
      transcripts: {},
      projects: {},
      lastSweep: { startedAt: 'yesterday', outcome: 'budget' },
    }),
  },
])('reports a damaged index as malformed: $rule', async ({ text }) => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-sweep-index-');
  await writeIndexText(agentDirectory, text);
  const before = await directoryState(agentDirectory);

  const read = await readSweepIndex(agentDirectory);

  expect(read).toMatchObject({ status: 'malformed' });
  expect(read.status === 'malformed' ? read.reason : '').toContain(sweepIndexPath(agentDirectory));
  expect(await directoryState(agentDirectory)).toEqual(before);
});

it('reports a newer index with its notice', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-sweep-index-');
  await writeIndexText(agentDirectory, JSON.stringify({ version: 2 }));
  const before = await directoryState(agentDirectory);

  const read = await readSweepIndex(agentDirectory);

  expect(read.status).toBe('newer');
  expect(read.status === 'newer' ? read.notice : '').toContain(sweepIndexPath(agentDirectory));
  expect(await directoryState(agentDirectory)).toEqual(before);
});

it('writes an index that reads back equal', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-sweep-index-');
  const index = await readFixture();
  const directory = join(agentDirectory, 'tau', 'improvement');

  await writeSweepIndex(agentDirectory, index);

  expect(await readSweepIndex(agentDirectory)).toEqual({ status: 'read', index });
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
});
