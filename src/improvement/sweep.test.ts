import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.ts';
import { createSweepFixture, eventHash } from '../../tests/sweepHarness.ts';
import { sessionHeader } from '../../tests/transcriptHarness.ts';
import { withFileLock } from '../fileLock/fileLock.ts';
import { readEvents } from './event.ts';
import { readSweepIndex, sweepIndexPath } from './sweepIndex.ts';

type PositionalRead = (
  this: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => ReturnType<FileHandle['read']>;

const repository = 'github.com/sQVe/tau';

const merged = (number: number, headRefName: string) => ({
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  headRefName,
  createdAt: '2026-11-01T00:00:00.000Z',
  mergedAt: '2026-11-15T11:58:00.000Z',
});

const twoMerged = () => [
  merged(562, 'me-1023-launch-subagent-workers-as-hc-children-with-assignment-files'),
  merged(564, 'me-1024-enforce-worker-deadlines-with-an-hc-watchdog'),
];

const expectedIds = (numbers: readonly number[]) =>
  numbers
    .flatMap((number) => [
      `facts-${eventHash(repository, number)}`,
      `merge-${eventHash(repository, number)}`,
    ])
    .toSorted();

const recordReads = async (path: string, reads: { length: number; position: number }[]) => {
  const probe = await open(path);
  const handle = Object.getPrototypeOf(probe) as FileHandle;
  const read = handle.read as PositionalRead;

  await probe.close();

  const record = (original: PositionalRead): PositionalRead =>
    function (buffer, offset, length, position) {
      reads.push({ length, position });

      return original.call(this, buffer, offset, length, position);
    };

  const spy = vi.spyOn(handle, 'read').mockImplementation(record(read) as FileHandle['read']);

  onTestFinished(() => {
    spy.mockRestore();
  });
};

it('rewrites every real path in a saved session fixture', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');

  expect(readFileSync(path, 'utf8')).not.toContain('/home/sqve/code/personal/tau/');
});

it('writes one merge event per merged pull request', async () => {
  const fixture = await createSweepFixture(onTestFinished);

  fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');
  fixture.setMerged(twoMerged());

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const events = await readEvents(fixture.repository);

  const mergedEventIds = events.events.map((event) => event.id).toSorted();
  expect(mergedEventIds).toEqual(expectedIds([562, 564]));

  const files = fixture.eventFiles();

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });
  expect(fixture.eventFiles()).toEqual(files);
});

it('writes facts once the publishing calls reach a transcript', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');
  const [header = '', ...body] = readFileSync(path, 'utf8').split(/(?<=\n)/u);

  writeFileSync(path, header);
  fixture.setMerged(twoMerged());

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const expectedEventFiles = [
    `merge-${eventHash(repository, 562)}`,
    `merge-${eventHash(repository, 564)}`,
  ]
    .toSorted()
    .map((id) => `${id}.json`);

  expect(fixture.eventFiles()).toEqual(expectedEventFiles);

  appendFileSync(path, body.join(''));

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });
  const expectedEventFilesAfterCatchUp = expectedIds([562, 564]).map((id) => `${id}.json`);
  expect(fixture.eventFiles()).toEqual(expectedEventFilesAfterCatchUp);
});

it('writes each event once across concurrent sweeps', async () => {
  const fixture = await createSweepFixture(onTestFinished);

  fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');
  fixture.setMerged(twoMerged());

  const outcomes = await Promise.all([fixture.run(), fixture.run()]);

  expect(outcomes).toEqual([{ outcome: 'caughtUp' }, { outcome: 'caughtUp' }]);
  const expectedEventFiles = expectedIds([562, 564]).map((id) => `${id}.json`);
  expect(fixture.eventFiles()).toEqual(expectedEventFiles);
});

it('reads only bytes after the cursor', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');

  const line = `${JSON.stringify({
    type: 'message',
    id: 'later',
    timestamp: '2026-11-04T00:00:00.000Z',
    message: { role: 'assistant', content: [] },
  })}\n`;

  fixture.setMerged(twoMerged());

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const before = await fixture.readIndex();
  const entry = before.transcripts[path];

  expect(entry?.status).toBe('resolved');

  if (entry?.status !== 'resolved') {
    throw new Error('The transcript is not resolved.');
  }

  appendFileSync(path, line);

  const reads: { length: number; position: number }[] = [];

  await recordReads(path, reads);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  expect(reads).toEqual([{ length: Buffer.byteLength(line), position: entry.cursor }]);

  const after = await fixture.readIndex();
  const advanced = after.transcripts[path];

  const cursor = advanced?.status === 'resolved' ? advanced.cursor : undefined;
  expect(cursor).toBe(entry.cursor + Buffer.byteLength(line));
});

it('records unknown when gh fails and moves no cursor', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');

  fixture.setMerged(twoMerged());

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const before = await fixture.readIndex();
  const entry = before.transcripts[path];

  fixture.fake.failCommand('merged', 'gh failed');
  fixture.advance(1000);

  expect(await fixture.run()).toEqual({
    outcome: 'failed',
    reason: expect.stringContaining('gh failed') as string,
  });

  const after = await fixture.readIndex();
  const project = Object.values(after.projects)[0];

  expect(project?.merged).toMatchObject({
    status: 'unknown',
    reason: expect.stringContaining('gh failed') as string,
  });

  expect(after.transcripts[path]).toEqual(entry);
});

it('rebuilds the index after it is deleted', async () => {
  const fixture = await createSweepFixture(onTestFinished);

  fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');
  fixture.setMerged(twoMerged());

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const before = await fixture.readIndex();
  const files = fixture.eventFiles();

  rmSync(sweepIndexPath(fixture.agentDirectory));

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });
  expect(await fixture.readIndex()).toEqual(before);
  expect(fixture.eventFiles()).toEqual(files);
});

it('stops at the budget and continues next run', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const secondRepository = await createTemporaryRepository(onTestFinished);

  await git(secondRepository, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau-two.git');

  const firstContent = [
    JSON.stringify({
      type: 'session',
      id: 'first',
      timestamp: '2026-11-01T00:00:00.000Z',
      cwd: fixture.repository,
    }),
    JSON.stringify({
      type: 'message',
      id: 'launch',
      timestamp: '2026-11-02T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'launch', name: 'subagent', arguments: {} }],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'launch-result',
      timestamp: '2026-11-02T00:01:00.000Z',
      message: { role: 'toolResult', toolCallId: 'launch', details: { taskId: 'w-bad' } },
    }),
    JSON.stringify({
      type: 'message',
      id: 'verify',
      timestamp: '2026-11-03T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'verify',
            name: 'pr',
            arguments: { action: 'verify', repository, pr: 562 },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'verify-result',
      timestamp: '2026-11-03T00:01:00.000Z',
      message: { role: 'toolResult', toolCallId: 'verify', details: { matches: true } },
    }),
  ].join('\n');

  const secondContent = `${JSON.stringify({
    type: 'session',
    id: 'second',
    timestamp: '2026-11-01T00:00:00.000Z',
    cwd: secondRepository,
  })}\n`;

  fixture.writeSession('first.jsonl', `${firstContent}\n`);
  fixture.writeSession('second.jsonl', secondContent);

  mkdirSync(join(fixture.agentDirectory, 'tau', 'main-1', 'workers', 'w-bad'), {
    recursive: true,
  });

  writeFileSync(
    join(fixture.agentDirectory, 'tau', 'main-1', 'workers', 'w-bad', 'task.json'),
    '{"createdAt":1}',
  );

  fixture.setMerged([merged(562, 'me-1023-change')]);

  const start = new Date('2026-11-15T12:00:00.000Z');
  const budget = 1000;

  const started = () =>
    [fixture.repository, secondRepository].some((root) =>
      existsSync(join(root, '.tau', 'improvement')),
    );

  const clock = () => (started() ? new Date(start.getTime() + budget) : start);

  expect(await fixture.run({ now: clock, budgetMilliseconds: budget })).toEqual({
    outcome: 'budget',
  });

  fixture.setNow(start);
  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const after = await fixture.readIndex();

  const mergedStatuses = Object.values(after.projects)
    .map((project) => project.merged.status)
    .toSorted();

  expect(mergedStatuses).toEqual(['read', 'read']);
});

it('refuses to publish over a newer event', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const directory = join(fixture.repository, '.tau', 'improvement');

  fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');
  fixture.setMerged([merged(562, 'me-1023-change')]);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'newer.json'), JSON.stringify({ version: 3 }));

  expect(await fixture.run()).toEqual({
    outcome: 'failed',
    reason: expect.stringContaining('newer.json') as string,
  });

  const after = await fixture.readIndex();
  const project = Object.values(after.projects)[0];

  expect(project?.merged).toMatchObject({ status: 'unknown' });
  expect(fixture.eventFiles()).toEqual(['newer.json']);
});

it('returns budget and writes nothing when the lock wait runs out', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const acquired = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const lockPath = join(fixture.agentDirectory, 'tau', 'improvement', 'sweep.lock');

  const holder = withFileLock(
    {
      cancelled: () => new Error('The holder was cancelled.'),
      lockPath,
      checkout: 'holder',
      signal: undefined,
      pollMilliseconds: 1000,
      onWaiting: () => undefined,
    },
    () => {
      acquired.resolve(undefined);

      return release.promise;
    },
  );

  await acquired.promise;

  try {
    expect(await fixture.run({ budgetMilliseconds: 20 })).toEqual({ outcome: 'budget' });
    expect(await readSweepIndex(fixture.agentDirectory)).toEqual({ status: 'missing' });
    expect(fixture.eventFiles()).toEqual([]);
  } finally {
    release.resolve(undefined);
    await holder;
  }
});

it('returns failed for a newer index without changing it', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = sweepIndexPath(fixture.agentDirectory);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 2 }));

  const before = readFileSync(path, 'utf8');
  const outcome = await fixture.run();

  expect(outcome).toEqual({
    outcome: 'failed',
    reason: expect.stringContaining(path) as string,
  });

  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(fixture.eventFiles()).toEqual([]);
});

it('stops when the caller signal aborts and saves progress', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const controller = new AbortController();
  const path = fixture.writeSession('manager.jsonl', `${sessionHeader(fixture.repository)}\n`);
  const gate = fixture.gateMergedList();

  const run = fixture.run({ signal: controller.signal });

  await gate.reached;
  controller.abort();

  expect(await run).toEqual({ outcome: 'budget' });

  const index = await fixture.readIndex();

  expect(index.lastSweep).toMatchObject({ outcome: 'budget' });

  expect(index.transcripts[path]).toMatchObject({
    status: 'resolved',
    cwd: fixture.repository,
    projectRoot: fixture.repository,
  });
});

it('rejects a budget that is not a positive integer', async () => {
  const fixture = await createSweepFixture(onTestFinished);

  await expect(fixture.run({ budgetMilliseconds: 0 })).rejects.toThrow(RangeError);
  await expect(fixture.run({ budgetMilliseconds: 1.5 })).rejects.toThrow(RangeError);
  expect(await readSweepIndex(fixture.agentDirectory)).toEqual({ status: 'missing' });
});
