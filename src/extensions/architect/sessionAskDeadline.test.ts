import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { hiddenAsk, hiddenIds } from './fixtures/hiddenAsk.js';
import { holdAskLock } from './fixtures/toolHarness.js';
import { endOptions, hcRuntime, sessionContext, stubArchitect } from './fixtures/visibleSession.js';
import { askRecordPath, readAskRecord, writeAskRecord } from './record.js';
import { createHeldLockToken, endArchitectSession, startArchitectSession } from './session.js';

const flushMacrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

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

it('an ask session shutdown during a clock change leaves no deadline timer armed', async ({
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
  const now = Date.now();
  const deadline = now + 1000;

  await writeAskRecord(root, { ...hiddenAsk('running', 'running'), deadline });
  vi.stubEnv('TAU_ARCHITECT_ASK', askRecordPath(root, hiddenIds.running));

  const scheduled: (() => unknown)[] = [];
  const setTimeoutFake = globalThis.setTimeout;

  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    const handle = setTimeoutFake(callback, delay, ...args);

    if (typeof callback === 'function') {
      scheduled.push(callback);
    }

    return handle;
  });

  const { context, shutdown } = sessionContext(root);
  const session = await startArchitectSession(context, createHeldLockToken());

  vi.clearAllTimers();
  vi.setSystemTime(now - 5000);

  const callback = scheduled.at(-1);

  if (callback === undefined) {
    throw new Error('The deadline timer was not scheduled.');
  }

  callback();

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    endOptions(),
  );

  expect(vi.getTimerCount()).toBe(0);
  expect(shutdown).not.toHaveBeenCalled();
});

it('an ask session rearms the deadline when the timer fires before the saved deadline', async ({
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
  const now = Date.now();
  const deadline = now + 1000;

  await writeAskRecord(root, { ...hiddenAsk('running', 'running'), deadline });
  vi.stubEnv('TAU_ARCHITECT_ASK', askRecordPath(root, hiddenIds.running));

  const expired = Promise.withResolvers<undefined>();
  const { context, shutdown } = sessionContext(root);

  shutdown.mockImplementation(() => {
    expired.resolve(undefined);
  });

  const session = await startArchitectSession(context, createHeldLockToken());

  vi.setSystemTime(now - 5000);

  await vi.advanceTimersByTimeAsync(1000);

  for (let attempt = 0; attempt < 100 && vi.getTimerCount() === 0; attempt += 1) {
    await flushMacrotask();
  }

  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'running' });
  expect(shutdown).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(5000);
  await expired.promise;

  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'timeout' });
  expect(shutdown).toHaveBeenCalledTimes(1);

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    endOptions(),
  );
});
