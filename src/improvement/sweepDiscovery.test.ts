import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { git, initializeRepository } from '../../tests/gitRepository.ts';
import { createSweepFixture, eventHash } from '../../tests/sweepHarness.ts';
import { readEvents } from './event.ts';
import { discoverTranscripts, resolveTranscript } from './sweepDiscovery.ts';

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

it('saves an unresolved entry when the cwd is below a file', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const blocker = join(fixture.agentDirectory, 'blocker');
  const cwd = join(blocker, 'child');

  writeFileSync(blocker, 'not a directory');
  fixture.setMerged([]);

  const path = fixture.writeSession('manager.jsonl', session(cwd));

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const before = await fixture.readIndex();

  expect(before.transcripts[path]).toMatchObject({
    status: 'unresolved',
    cwd,
    reason: expect.stringContaining('does not exist') as string,
  });

  rmSync(blocker);
  mkdirSync(blocker);
  await initializeRepository(blocker);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const after = await fixture.readIndex();

  expect(after.transcripts[path]).toMatchObject({ status: 'resolved', cwd });
});

it('saves an unresolved entry when no ancestor is a repository', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const cwd = join(fixture.agentDirectory, 'gone', 'deeper');
  const path = fixture.writeSession('manager.jsonl', session(cwd));

  fixture.setMerged([]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const before = await fixture.readIndex();

  expect(before.transcripts[path]).toMatchObject({
    status: 'unresolved',
    cwd,
    reason: expect.stringContaining('git rev-parse') as string,
  });

  await initializeRepository(fixture.agentDirectory);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const after = await fixture.readIndex();

  expect(after.transcripts[path]).toMatchObject({ status: 'resolved', cwd });
});

it('saves an unresolved entry when the first line is not a session header', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeSession('manager.jsonl', '{"type":"message"}\n');

  fixture.setMerged([]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const before = await fixture.readIndex();

  expect(before.transcripts[path]).toMatchObject({
    status: 'unresolved',
    reason: expect.stringContaining('first line is not a session header') as string,
  });

  writeFileSync(path, session(fixture.repository));

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const after = await fixture.readIndex();

  expect(after.transcripts[path]).toMatchObject({
    status: 'resolved',
    cwd: fixture.repository,
  });
});

it('resolves a session header followed by a malformed line', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeSession('manager.jsonl', `${session(fixture.repository)}{not json\n`);

  fixture.setMerged([]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const index = await fixture.readIndex();

  expect(index.transcripts[path]).toMatchObject({
    status: 'resolved',
    cwd: fixture.repository,
    projectRoot: fixture.repository,
  });
});

it('retries a session file that disappeared before it was read', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = join(fixture.agentDirectory, 'sessions', 'vanished.jsonl');
  const signal = new AbortController().signal;

  const missing = await resolveTranscript({
    path,
    exec: fixture.fake.exec,
    signal,
    cache: new Map(),
  });

  expect(missing.entry).toMatchObject({
    status: 'unresolved',
    reason: expect.stringContaining('session file is missing') as string,
  });

  fixture.writeSession('vanished.jsonl', session(fixture.repository));

  const start = new Date('2026-11-15T12:00:00.000Z');

  const result = await discoverTranscripts({
    agentDirectory: fixture.agentDirectory,
    index: {
      version: 1,
      transcripts: { [path]: missing.entry },
      projects: {},
      lastSweep: null,
    },
    exec: fixture.fake.exec,
    signal,
    now: () => start,
    deadline: start.getTime() + 1000,
  });

  expect(result.status).toBe('ok');

  expect(result.status === 'ok' ? result.index.transcripts[path] : undefined).toMatchObject({
    status: 'resolved',
    cwd: fixture.repository,
  });
});
