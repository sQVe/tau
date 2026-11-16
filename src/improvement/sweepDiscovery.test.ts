import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { git, initializeRepository } from '../../tests/gitRepository.ts';
import { createSweepFixture, eventHash } from '../../tests/sweepHarness.ts';
import { readEvents } from './event.ts';
import { discoverTranscripts } from './sweepDiscovery.ts';

const merged = (number: number, headRefName: string) => ({
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  headRefName,
  createdAt: '2026-11-01T00:00:00.000Z',
  mergedAt: '2026-11-15T11:58:00.000Z',
});

const session = (cwd: string) =>
  `${JSON.stringify({
    type: 'session',
    id: 'manager',
    timestamp: '2026-11-01T00:00:00.000Z',
    cwd,
  })}\n`;

it('resolves a transcript through the nearest existing ancestor of its cwd', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const missingCwd = join(fixture.repository, 'gone', 'deeper');
  const path = fixture.writeSession('manager.jsonl', session(missingCwd));

  fixture.setMerged([]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const index = await fixture.readIndex();

  expect(index.transcripts[path]).toMatchObject({
    status: 'resolved',
    cwd: missingCwd,
    projectRoot: fixture.repository,
  });
});

it('retries an unresolved transcript on the next sweep', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const directory = join(fixture.agentDirectory, 'becomes-a-repository');
  const path = fixture.writeSession('manager.jsonl', session(directory));

  mkdirSync(directory, { recursive: true });
  fixture.setMerged([]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const before = await fixture.readIndex();

  expect(before.transcripts[path]?.status).toBe('unresolved');

  await initializeRepository(directory);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const after = await fixture.readIndex();

  expect(after.transcripts[path]).toMatchObject({
    status: 'resolved',
    cwd: directory,
    projectRoot: directory,
  });
});

it('records a project without an origin repository as unknown', async () => {
  const fixture = await createSweepFixture(onTestFinished);

  await git(fixture.repository, 'remote', 'remove', 'origin');
  fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const index = await fixture.readIndex();
  const project = index.projects[fixture.repository];

  expect(project?.repository).toBeNull();
  expect(project?.merged.status).toBe('unknown');

  await git(fixture.repository, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');
  fixture.setMerged([merged(562, 'me-1023-change')]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const events = await readEvents(fixture.repository);
  const after = await fixture.readIndex();

  expect(events.events.map((event) => event.id)).toContain(
    `merge-${eventHash('github.com/sQVe/tau', 562)}`,
  );

  expect(after.projects[fixture.repository]?.repository).toBe('github.com/sQVe/tau');
  expect(after.projects[fixture.repository]?.merged.status).toBe('read');
});

it('stops discovery at the budget before reading a transcript', async () => {
  const fixture = await createSweepFixture(onTestFinished);

  fixture.writeSession('manager.jsonl', session(join(fixture.repository, 'gone')));
  fixture.setMerged([]);

  const start = new Date('2026-11-15T12:00:00.000Z');

  const result = await discoverTranscripts({
    agentDirectory: fixture.agentDirectory,
    index: { version: 1, transcripts: {}, projects: {}, lastSweep: null },
    exec: fixture.fake.exec,
    signal: new AbortController().signal,
    now: () => new Date(start.getTime() + 1),
    deadline: start.getTime(),
  });

  expect(result).toMatchObject({ status: 'budget', index: { transcripts: {} } });
});

it('saves each transcript discovered before the budget ends', async () => {
  const fixture = await createSweepFixture(onTestFinished);

  for (let index = 0; index < 4; index += 1) {
    fixture.writeSession(`manager-${index}.jsonl`, session(fixture.repository));
  }

  fixture.setMerged([merged(562, 'me-1023-change')]);

  const start = new Date('2026-11-15T12:00:00.000Z');
  const budget = 1000;
  let previous = 0;

  while (previous < 4) {
    let calls = 0;

    const clock = () => {
      calls += 1;

      return calls >= 4 ? new Date(start.getTime() + budget) : start;
    };

    const outcome = await fixture.run({ now: clock, budgetMilliseconds: budget });
    const index = await fixture.readIndex();
    const count = Object.keys(index.transcripts).length;

    expect(count).toBeGreaterThan(previous);
    expect(outcome.outcome === 'budget' || count === 4).toBe(true);
    previous = count;
  }

  fixture.setNow(start);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const events = await readEvents(fixture.repository);

  expect(events.events.some((event) => event.kind === 'merge')).toBe(true);
});
