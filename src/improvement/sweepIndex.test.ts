import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { isMissingFile } from '../errors.ts';
import { readSweepIndex, sweepIndexPath, writeSweepIndex } from './sweepIndex.ts';
import type { SweepIndex } from './sweepIndex.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

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

const validIndex = {
  version: 1,
  transcripts: {
    '/sessions/manager.jsonl': {
      status: 'resolved',
      cwd: '/code/tau',
      projectRoot: '/code/tau',
      cursor: 0,
      state: {
        header: 'found',
        calls: [],
        malformedLines: 0,
        droppedCallReasons: [],
      },
    },
  },
  projects: {},
  lastSweep: null,
};

const resolvedState = validIndex.transcripts['/sessions/manager.jsonl'].state;

const withState = (state: Record<string, unknown>) => ({
  ...validIndex,
  transcripts: {
    '/sessions/manager.jsonl': {
      ...validIndex.transcripts['/sessions/manager.jsonl'],
      state,
    },
  },
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
  {
    rule: 'an unknown state field',
    text: JSON.stringify(withState({ ...resolvedState, extra: true })),
  },
  {
    rule: 'an unknown call field',
    text: JSON.stringify(
      withState({
        ...resolvedState,
        calls: [
          {
            callId: 'call-1',
            tool: 'read',
            entryId: 'entry-1',
            timestamp: '2026-11-15T12:00:00.000Z',
            viaCodemode: false,
            extra: true,
          },
        ],
      }),
    ),
  },
  {
    rule: 'a negative malformed line count',
    text: JSON.stringify(withState({ ...resolvedState, malformedLines: -1 })),
  },
  {
    rule: 'a fractional malformed line count',
    text: JSON.stringify(withState({ ...resolvedState, malformedLines: 1.5 })),
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

it('refuses an index outside the test write root and creates nothing', async () => {
  const allowed = temporaryDirectory(onTestFinished, 'tau-sweep-index-');
  const outside = temporaryDirectory(onTestFinished, 'tau-sweep-index-');

  vi.stubEnv('TAU_TEST_WRITE_ROOT', allowed);

  await expect(writeSweepIndex(outside, await readFixture())).rejects.toThrow(
    `outside the test write root ${allowed}`,
  );

  expect(existsSync(join(outside, 'tau'))).toBe(false);
});

it('writes an index that reads back equal', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-sweep-index-');
  const index = await readFixture();
  const directory = join(agentDirectory, 'tau', 'improvement');

  await writeSweepIndex(agentDirectory, index);

  expect(await readSweepIndex(agentDirectory)).toEqual({ status: 'read', index });
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
});
