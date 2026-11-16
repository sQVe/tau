import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createSweepFixture, eventHash } from '../../tests/sweepHarness.ts';

const repository = 'github.com/sQVe/tau';

const laterLine = `${JSON.stringify({
  type: 'message',
  id: 'later',
  timestamp: '2026-11-04T00:00:00.000Z',
  message: { role: 'assistant', content: [] },
})}\n`;

const merged = (number: number, headRefName: string) => ({
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  headRefName,
  createdAt: '2026-11-01T00:00:00.000Z',
  mergedAt: '2026-11-15T11:58:00.000Z',
});

const lock = (path: string) => {
  chmodSync(path, 0o000);

  onTestFinished(() => {
    chmodSync(path, 0o644);
  });
};

const restoreDirectory = (path: string) => {
  chmodSync(path, 0o555);

  onTestFinished(() => {
    chmodSync(path, 0o755);
  });
};

it('keeps entries and events when a transcript becomes unreadable', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');

  fixture.setMerged([merged(562, 'me-1023-change')]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const before = await fixture.readIndex();
  const files = fixture.eventFiles();

  appendFileSync(path, '{"type":"message","id":"later"}\n');
  lock(path);

  expect(await fixture.run()).toEqual({
    outcome: 'failed',
    reason: expect.stringContaining('EACCES') as string,
  });

  const after = await fixture.readIndex();

  expect(after.transcripts[path]).toEqual(before.transcripts[path]);
  expect(fixture.eventFiles()).toEqual(files);
});

it('keeps entries and events when an event file is damaged', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');
  const directory = join(fixture.repository, '.tau', 'improvement');

  fixture.setMerged([merged(562, 'me-1023-change')]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'damaged.json'), '{not json');
  appendFileSync(path, laterLine);

  const before = await fixture.readIndex();
  const files = fixture.eventFiles();

  expect(await fixture.run()).toEqual({
    outcome: 'failed',
    reason: expect.stringContaining('damaged.json') as string,
  });

  const after = await fixture.readIndex();

  expect(after.transcripts[path]).toEqual(before.transcripts[path]);
  expect(fixture.eventFiles()).toEqual(files);
});

it('keeps entries and events when an event write fails', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');
  const directory = join(fixture.repository, '.tau', 'improvement');

  fixture.setMerged([merged(562, 'me-1023-change')]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  appendFileSync(path, laterLine);

  const before = await fixture.readIndex();
  const files = fixture.eventFiles();

  fixture.setMerged([merged(562, 'me-1023-change'), merged(564, 'me-1024-change')]);

  restoreDirectory(directory);

  expect(await fixture.run()).toEqual({
    outcome: 'failed',
    reason: expect.stringContaining('EACCES') as string,
  });

  const after = await fixture.readIndex();

  expect(after.transcripts[path]).toEqual(before.transcripts[path]);
  expect(fixture.eventFiles()).toEqual(files);
});

it('stops at the budget during publication', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');

  fixture.setMerged([merged(562, 'me-1023-change')]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  appendFileSync(path, laterLine);

  const before = await fixture.readIndex();
  const files = fixture.eventFiles();

  fixture.setMerged([merged(562, 'me-1023-change'), merged(564, 'me-1024-change')]);

  const start = new Date('2026-11-15T12:00:00.000Z');
  const budget = 1000;
  const mergeName = `merge-${eventHash(repository, 564)}.json`;
  const mergePath = join(fixture.repository, '.tau', 'improvement', mergeName);

  // The new merge event marks the publication step, so the budget ends after the transcripts were read.
  const clock = () => (existsSync(mergePath) ? new Date(start.getTime() + budget) : start);

  expect(await fixture.run({ now: clock, budgetMilliseconds: budget })).toEqual({
    outcome: 'budget',
  });

  const after = await fixture.readIndex();

  expect(existsSync(mergePath)).toBe(true);
  expect(after.transcripts[path]).toEqual(before.transcripts[path]);
  expect(fixture.eventFiles()).toEqual([...files, mergeName].toSorted());
});
