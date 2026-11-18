import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createSweepFixture, eventHash } from '../../tests/sweepHarness.ts';
import { readEvents } from './event.ts';

const repository = 'github.com/sQVe/tau';

const entry = (id: string, timestamp: string, message: Record<string, unknown>) =>
  JSON.stringify({ type: 'message', id, timestamp, message });

const call = (id: string, timestamp: string, name: string, parameters: unknown) =>
  entry(id, timestamp, {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: parameters }],
  });

const result = (id: string, timestamp: string, details: Record<string, unknown>) =>
  entry(id, timestamp, { role: 'toolResult', toolCallId: id, details });

const managerTranscript = (cwd: string) =>
  [
    JSON.stringify({
      type: 'session',
      id: 'manager',
      timestamp: '2026-11-01T00:00:00.000Z',
      cwd,
    }),
    call('launch', '2026-11-02T00:00:00.000Z', 'subagent', { profile: 'worker' }),
    result('launch', '2026-11-02T00:01:00.000Z', { taskId: 'w1' }),
    call('verify', '2026-11-03T00:00:00.000Z', 'pr', {
      action: 'verify',
      repository,
      pr: 700,
    }),
    result('verify', '2026-11-03T00:01:00.000Z', { matches: true }),
  ].join('\n') + '\n';

it('keeps worker facts after the worker transcript is deleted', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const workerDirectory = join(fixture.agentDirectory, 'tau', 'main-1', 'workers', 'w1');
  const workerSession = join(workerDirectory, 'session.jsonl');

  fixture.writeSession('manager.jsonl', managerTranscript(fixture.repository));
  mkdirSync(workerDirectory, { recursive: true });
  writeFileSync(join(workerDirectory, 'task.json'), '{"taskId":"w1","createdAt":1}');

  writeFileSync(
    workerSession,
    `${JSON.stringify({ type: 'session', id: 'worker', timestamp: '2026-11-02T00:00:00.000Z', cwd: fixture.repository })}\n`,
  );

  fixture.setMerged([
    {
      number: 700,
      url: 'https://github.com/sQVe/tau/pull/700',
      headRefName: 'me-700-change',
      createdAt: '2026-11-01T00:00:00.000Z',
      mergedAt: '2026-11-15T11:58:00.000Z',
    },
  ]);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });

  const factsId = `facts-${eventHash(repository, 700)}`;
  const before = await readEvents(fixture.repository);
  const facts = before.events.find((event) => event.id === factsId);

  const coverage = facts?.kind === 'facts' ? facts.coverage : undefined;
  expect(coverage).toBe('complete');

  rmSync(workerSession);
  fixture.advance(1000);

  expect(await fixture.run()).toEqual({ outcome: 'caughtUp' });
  expect(await readEvents(fixture.repository)).toEqual(before);
});
