import { rmSync, writeFileSync } from 'node:fs';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.ts';
import { createSweepFixture, eventHash } from '../../tests/sweepHarness.ts';
import { readEvents } from './event.ts';

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

  const replacement = [
    JSON.stringify({
      type: 'session',
      id: 'replacement',
      timestamp: '2026-11-16T00:00:00.000Z',
      cwd: secondRepository,
    }),
    JSON.stringify({
      type: 'message',
      id: 'verify',
      timestamp: '2026-11-16T00:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'verify',
            name: 'pr',
            arguments: { action: 'verify', repository: 'github.com/sQVe/tau-two', pr: 700 },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'verify-result',
      timestamp: '2026-11-16T00:02:00.000Z',
      message: { role: 'toolResult', toolCallId: 'verify', details: { matches: true } },
    }),
  ].join('\n');

  expect(Buffer.byteLength(replacement)).toBeLessThan(entry.cursor);

  writeFileSync(path, `${replacement}\n`);

  fixture.setMerged([
    {
      number: 700,
      url: 'https://github.com/sQVe/tau-two/pull/700',
      headRefName: 'me-700-change',
      createdAt: '2026-11-01T00:00:00.000Z',
      mergedAt: '2026-11-15T11:58:00.000Z',
    },
  ]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const after = await fixture.readIndex();

  expect(after.transcripts[path]).toMatchObject({
    status: 'resolved',
    cwd: secondRepository,
    projectRoot: secondRepository,
    cursor: 0,
    state: { header: 'pending', calls: [], malformedLines: 0, droppedCallReasons: [] },
  });

  expect(after.projects[secondRepository]).toMatchObject({ merged: { status: 'notRead' } });

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const final = await fixture.readIndex();
  const advanced = final.transcripts[path];

  expect(advanced?.status === 'resolved' ? advanced.cursor : undefined).toBe(
    Buffer.byteLength(`${replacement}\n`),
  );

  const events = await readEvents(secondRepository);

  expect(events.events.map((event) => event.id)).toContain(
    `merge-${eventHash('github.com/sQVe/tau-two', 700)}`,
  );
});
