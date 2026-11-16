import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { git, initializeRepository } from '../../tests/gitRepository.ts';
import { createSweepFixture } from '../../tests/sweepHarness.ts';

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
});
