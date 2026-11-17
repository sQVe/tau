import { readFile } from 'node:fs/promises';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { feedbackRead, published, sessionHeader } from '../../../tests/transcriptHarness.js';
import { hours, merged, minute, setup, url } from './fixtures/mergeWatchSetup.js';

vi.mock(import('node:fs/promises'), { spy: true });

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
  const { fake, handlers, runBash, emit, polls, writeTranscript } = setup();
  const readHeld = Promise.withResolvers<undefined>();
  const finishReturned = Promise.withResolvers<undefined>();
  const transcript = sessionHeader('/repository');

  writeTranscript([transcript]);

  vi.mocked(readFile).mockImplementationOnce(async () => {
    await readHeld.promise;

    setImmediate(() => {
      finishReturned.resolve(undefined);
    });

    return transcript;
  });

  await runBash('gh pr merge --auto');
  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute);

  await vi.advanceTimersByTimeAsync(2 * hours);

  expect(fake.sendMessage).not.toHaveBeenCalled();
  expect(polls()).toHaveLength(1);

  await emit('session_shutdown', { reason: 'quit' });
  readHeld.resolve(undefined);
  await finishReturned.promise;

  expect(fake.sendMessage).not.toHaveBeenCalled();
});
