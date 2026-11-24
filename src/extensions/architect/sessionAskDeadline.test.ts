import type { setTimeout as promiseDelay } from 'node:timers/promises';

import { expect, it, vi } from 'vitest';

import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { hiddenAsk, hiddenIds } from './fixtures/hiddenAsk.js';
import { holdAskLock } from './fixtures/toolHarness.js';
import { endOptions, hcRuntime, sessionContext, stubArchitect } from './fixtures/visibleSession.js';
import { askRecordPath, readAskRecord, writeAskRecord } from './record.js';
import { createHeldLockToken, endArchitectSession, startArchitectSession } from './session.js';
import type { ArchitectSession } from './session.js';

it('an ask session times out its running ask at the deadline and shuts down', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  stubArchitect(onTestFinished);

  const root = await createTemporaryRepository(onTestFinished);
  const deadline = Date.now();

  await writeAskRecord(root, { ...hiddenAsk('running', 'running'), deadline });
  vi.stubEnv('TAU_ARCHITECT_ASK', askRecordPath(root, hiddenIds.running));

  const expired = Promise.withResolvers<undefined>();
  const { context, shutdown } = sessionContext(root);

  shutdown.mockImplementation(() => {
    expired.resolve(undefined);
  });

  const session = await startArchitectSession(context, createHeldLockToken());

  await vi.advanceTimersByTimeAsync(1);
  await expired.promise;

  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'timeout' });
  expect(shutdown).toHaveBeenCalledTimes(1);

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    endOptions(),
  );
});

it('an ask session shutdown before the deadline never writes the deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  stubArchitect(onTestFinished);

  const root = await createTemporaryRepository(onTestFinished);
  const deadline = Date.now() + 1000;

  await writeAskRecord(root, { ...hiddenAsk('running', 'running'), deadline });
  vi.stubEnv('TAU_ARCHITECT_ASK', askRecordPath(root, hiddenIds.running));

  const { context } = sessionContext(root);
  const session = await startArchitectSession(context, createHeldLockToken());

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    endOptions(),
  );

  expect(vi.getTimerCount()).toBe(0);

  await vi.advanceTimersByTimeAsync(5000);

  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({
    status: 'failed',
    detail: 'The architect session ended before it sent the answer.',
  });
});

it('an ask session waits for a stalled expiry and settles it as timeout', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  stubArchitect(onTestFinished);

  const root = await createTemporaryRepository(onTestFinished);
  const deadline = Date.now();

  await writeAskRecord(root, { ...hiddenAsk('running', 'running'), deadline });
  vi.stubEnv('TAU_ARCHITECT_ASK', askRecordPath(root, hiddenIds.running));

  const held = await holdAskLock(onTestFinished, root, hiddenIds.running);
  const { context } = sessionContext(root);
  const session = await startArchitectSession(context, createHeldLockToken());

  await vi.advanceTimersByTimeAsync(1);

  const ending = endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    endOptions(),
  );

  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'running' });

  expect((session as ArchitectSession).held.current()).toBeUndefined();

  held.release();
  await ending;

  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'timeout' });
});

it('an ask session writes nothing at the deadline for an already settled record', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  stubArchitect(onTestFinished);

  const root = await createTemporaryRepository(onTestFinished);
  const deadline = Date.now();

  await writeAskRecord(root, { ...hiddenAsk('sent', 'sent'), deadline });
  vi.stubEnv('TAU_ARCHITECT_ASK', askRecordPath(root, hiddenIds.sent));

  const { context, shutdown } = sessionContext(root);
  const session = await startArchitectSession(context, createHeldLockToken());

  await vi.advanceTimersByTimeAsync(1);

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    endOptions(),
  );

  expect(await readAskRecord(root, hiddenIds.sent)).toMatchObject({ status: 'sent' });
  expect(shutdown).not.toHaveBeenCalled();
});

it('an ask session ends without the ask lock for an already settled record', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  stubArchitect(onTestFinished);

  const root = await createTemporaryRepository(onTestFinished);
  const deadline = Date.now();

  await writeAskRecord(root, { ...hiddenAsk('sent', 'sent'), deadline });
  vi.stubEnv('TAU_ARCHITECT_ASK', askRecordPath(root, hiddenIds.sent));

  const held = await holdAskLock(onTestFinished, root, hiddenIds.sent);
  const { context, shutdown } = sessionContext(root);
  const session = await startArchitectSession(context, createHeldLockToken());

  await vi.advanceTimersByTimeAsync(1);

  const actual = await vi.importActual<{ setTimeout: typeof promiseDelay }>('node:timers/promises');

  const stillWaiting = actual.setTimeout(3000).then(() => 'still-waiting' as const);

  const ending = endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    endOptions(),
  ).then(() => 'ended' as const);

  expect(await Promise.race([ending, stillWaiting])).toBe('ended');
  expect(shutdown).not.toHaveBeenCalled();
  expect(await readAskRecord(root, hiddenIds.sent)).toMatchObject({ status: 'sent' });

  held.release();
});

it('an ask session retries the deadline after a guard refusal', async ({ onTestFinished }) => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  stubArchitect(onTestFinished);

  const root = await createTemporaryRepository(onTestFinished);
  const deadline = Date.now() + 1000;
  const path = askRecordPath(root, hiddenIds.running);

  await writeAskRecord(root, { ...hiddenAsk('running', 'running'), deadline });
  vi.stubEnv('TAU_ARCHITECT_ASK', path);

  const refused = Promise.withResolvers<undefined>();
  const { context, notify, shutdown } = sessionContext(root);

  notify.mockImplementation(() => {
    refused.resolve(undefined);
  });

  const session = await startArchitectSession(context, createHeldLockToken());

  await git(root, 'add', '--force', '--', path);
  await vi.advanceTimersByTimeAsync(1000);
  await refused.promise;

  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining('Git tracks files in .tau/lead/ask'),
    'error',
  );

  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'running' });

  await git(root, 'rm', '--cached', '--', path);
  await vi.advanceTimersByTimeAsync(5000);

  await vi.waitFor(
    async () => {
      expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'timeout' });
      expect(shutdown).toHaveBeenCalledTimes(1);
    },
    { timeout: 10_000, interval: 10 },
  );

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    endOptions(),
  );
});
