import { rmSync, writeFileSync } from 'node:fs';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.ts';
import { createSweepFixture } from '../../tests/sweepHarness.ts';

const merged = (number: number, headRefName: string) => ({
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  headRefName,
  createdAt: '2026-11-01T00:00:00.000Z',
  mergedAt: '2026-11-15T11:58:00.000Z',
});

it('removes a transcript that no longer exists', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');

  fixture.setMerged([merged(562, 'me-1023-change')]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const before = await fixture.readIndex();

  expect(before.transcripts[path]?.status).toBe('resolved');

  rmSync(path);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const after = await fixture.readIndex();

  expect(after.transcripts[path]).toBeUndefined();
});

it('restarts a replaced transcript at zero and resolves its cwd again', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const path = fixture.writeFixtureSession('manager.jsonl', 'multiplePublications.jsonl');

  fixture.setMerged([merged(562, 'me-1023-change')]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const before = await fixture.readIndex();
  const entry = before.transcripts[path];

  if (entry?.status !== 'resolved') {
    throw new Error('The transcript is not resolved.');
  }

  const secondRepository = await createTemporaryRepository(onTestFinished);

  await git(secondRepository, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau-two.git');

  const replacement = `${JSON.stringify({
    type: 'session',
    id: 'replacement',
    timestamp: '2026-11-16T00:00:00.000Z',
    cwd: secondRepository,
  })}\n`;

  expect(Buffer.byteLength(replacement)).toBeLessThan(entry.cursor);

  writeFileSync(path, replacement);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const after = await fixture.readIndex();

  expect(after.transcripts[path]).toMatchObject({
    status: 'resolved',
    cwd: secondRepository,
    projectRoot: secondRepository,
    cursor: Buffer.byteLength(replacement),
  });

  expect(Object.keys(after.projects)).toContain(secondRepository);
});
