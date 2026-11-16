import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { hours, merged, minute, setup, url } from './fixtures/mergeWatchSetup.js';

const repository = 'github.com/owner/repo';

const sessionHeader = (cwd: string) =>
  JSON.stringify({ type: 'session', id: 's', timestamp: '2026-11-01T00:00:00.000Z', cwd });

const entry = (id: string, timestamp: string, message: Record<string, unknown>) =>
  JSON.stringify({ type: 'message', id, timestamp, message });

const call = (
  id: string,
  timestamp: string,
  name: string,
  parameters: Record<string, unknown>,
  details: Record<string, unknown> = {},
) => [
  entry(id, timestamp, {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: parameters }],
  }),
  entry(`${id}-result`, timestamp, {
    role: 'toolResult',
    toolCallId: id,
    details,
  }),
];

const published = (pr: number) =>
  call('verify', '2026-11-01T00:01:00.000Z', 'pr', {
    action: 'verify',
    repository,
    pr,
  });

const feedbackRead = (index: number, pr: number) =>
  call(`feedback-${index}`, `2026-11-01T00:0${index + 2}:00.000Z`, 'pr_feedback', {
    action: 'read',
    pr,
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

it('offers a review when the merged task has a signal', async () => {
  const { fake, handlers, runBash, writeTranscript, nextDelivery } = setup();

  writeTranscript([
    sessionHeader('/repository'),
    ...published(7),
    ...feedbackRead(1, 7),
    ...feedbackRead(2, 7),
    ...feedbackRead(3, 7),
  ]);

  await runBash('gh pr merge --auto');
  handlers.state = () => merged;
  const delivered = nextDelivery();
  await vi.advanceTimersByTimeAsync(minute);
  await delivered;

  const content = fake.sendMessage.mock.calls[0]?.[0].content;

  expect(content).toContain('PR feedback rounds');
  expect(content).toContain('retrospective skill');
});

it('sends the plain message when the merged task has no signal', async () => {
  const { fake, handlers, runBash, writeTranscript, nextDelivery } = setup();

  writeTranscript([sessionHeader('/repository'), ...published(7), ...feedbackRead(1, 7)]);

  await runBash('gh pr merge --auto');
  handlers.state = () => merged;
  const delivered = nextDelivery();
  await vi.advanceTimersByTimeAsync(minute);
  await delivered;

  const content = fake.sendMessage.mock.calls[0]?.[0].content;

  expect(content).toBe(`Pull request ${url} merged.`);
});

it('says review signals unknown when the merged pull request cannot be read', async () => {
  const { fake, handlers, execFake, runBash, nextDelivery } = setup();

  execFake.failCommand('merged');
  await runBash('gh pr merge --auto');
  handlers.state = () => merged;
  const delivered = nextDelivery();
  await vi.advanceTimersByTimeAsync(minute);
  await delivered;

  const content = fake.sendMessage.mock.calls[0]?.[0].content;

  expect(content).toBe(`Pull request ${url} merged; review signals unknown.`);
  expect(content).not.toContain('retrospective skill');
});

it('keeps the merged watch from its deadline and next poll while the signal read is open', async () => {
  const { fake, handlers, runBash, emit, polls, sessionDirectory } = setup();

  mkdirSync(sessionDirectory, { recursive: true });
  const transcriptPath = join(sessionDirectory, 'main.jsonl');
  await promisify(execFile)('mkfifo', [transcriptPath]);

  await runBash('gh pr merge --auto');
  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute);

  const writer = await open(transcriptPath, 'w');

  await vi.advanceTimersByTimeAsync(2 * hours);

  expect(fake.sendMessage).not.toHaveBeenCalled();
  expect(polls()).toHaveLength(1);

  await emit('session_shutdown', { reason: 'quit' });
  await writer.close();
  await delay(50);

  expect(fake.sendMessage).not.toHaveBeenCalled();
});
