import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { withFileLock } from '../../fileLock/fileLock.js';
import type * as FileLockModule from '../../fileLock/fileLock.js';
import { hiddenAsk, hiddenIds } from './fixtures/hiddenAsk.js';
import { endOptions, hcRuntime, sessionContext, stubArchitect } from './fixtures/visibleSession.js';
import { askRecordPath, readAskRecord, writeAskRecord } from './record.js';
import { createHeldLockToken, endArchitectSession, startArchitectSession } from './session.js';

vi.mock(import('../../fileLock/fileLock.js'), { spy: true });

const flushMacrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
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

it('an ask session rearms the deadline when the clock rolls back before the locked expiry', async ({
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

  let clock = deadline;

  const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
    const value = clock;
    clock = deadline - 6000;

    return value;
  });

  await vi.advanceTimersByTimeAsync(1000);

  for (let attempt = 0; attempt < 1000 && vi.getTimerCount() === 0; attempt += 1) {
    await flushMacrotask();
  }

  expect(vi.getTimerCount()).toBeGreaterThan(0);
  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'running' });
  expect(shutdown).not.toHaveBeenCalled();

  nowSpy.mockReturnValue(deadline);
  await vi.advanceTimersByTimeAsync(6000);
  await expired.promise;

  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'timeout' });
  expect(shutdown).toHaveBeenCalledTimes(1);

  nowSpy.mockRestore();

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    endOptions(),
  );
});

it('an ask session rearms at zero delay when the clock recrosses the deadline after a declined update', async ({
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

  const askLock = `${askRecordPath(root, hiddenIds.running)}.lock`;
  const locked = Promise.withResolvers<undefined>();
  const actual = await vi.importActual<typeof FileLockModule>('../../fileLock/fileLock.js');

  vi.mocked(withFileLock).mockImplementationOnce(async (options, run) => {
    if (options.lockPath !== askLock) {
      return actual.withFileLock(options, run);
    }

    locked.resolve(undefined);
    vi.setSystemTime(deadline - 6000);

    return actual.withFileLock(options, run);
  });

  const askLockCalls = (): number =>
    vi.mocked(withFileLock).mock.calls.filter(([options]) => options.lockPath === askLock).length;

  vi.setSystemTime(deadline);
  await vi.advanceTimersByTimeAsync(1000);
  await locked.promise;

  for (let attempt = 0; attempt < 1000 && vi.getTimerCount() === 0; attempt += 1) {
    await flushMacrotask();
  }

  expect(askLockCalls()).toBe(1);
  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'running' });
  expect(shutdown).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBeGreaterThan(0);

  vi.setSystemTime(deadline);
  await vi.advanceTimersByTimeAsync(6000);
  await expired.promise;

  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'timeout' });
  expect(shutdown).toHaveBeenCalledTimes(1);

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    endOptions(),
  );
});
