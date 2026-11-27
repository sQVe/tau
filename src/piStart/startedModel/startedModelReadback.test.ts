import { expect, it, vi } from 'vitest';

import {
  readStartedModel,
  readbackFailureBudgetMilliseconds,
  readbackNoForegroundBudgetMilliseconds,
} from './startedModelReadback.js';

vi.mock(import('node:timers/promises'), async (importOriginal) => {
  const original = await importOriginal();
  const { globalTimerDelay } = await import('../../../tests/timerFake.js');

  return { ...original, setTimeout: globalTimerDelay };
});

it('clears the read timer and abort listener when a read throws synchronously', async () => {
  const controller = new AbortController();
  const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
  let reads = 0;

  const read = (): Promise<readonly string[] | undefined> => {
    reads += 1;

    throw new Error('read failed');
  };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const reading = readStartedModel({
      readForegroundArgv: read,
      terminal: 't-new',
      model: undefined,
      message: undefined,
      signal: controller.signal,
      deadline: Date.now() + 30_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);

    expect(reads).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));

    controller.abort(new Error('cancelled'));

    expect(await reading).toBeInstanceOf(Error);
  } finally {
    removeListener.mockRestore();
    vi.useRealTimers();
  }
});

it('reports a permanent read failure without polling the whole budget', async () => {
  const failure = new Error('spawn hc ENOENT');
  let reads = 0;

  const read = (): Promise<readonly string[] | undefined> => {
    reads += 1;

    return Promise.reject(failure);
  };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const reading = readStartedModel({
      readForegroundArgv: read,
      terminal: 't-new',
      model: undefined,
      message: undefined,
      signal: undefined,
      deadline: Date.now() + 30_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(readbackFailureBudgetMilliseconds + 1_000);

    const outcome = await Promise.race([reading, Promise.resolve('waiting' as const)]);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('spawn hc ENOENT');
    expect((outcome as Error).message).not.toContain('It may still be running');
    expect((outcome as Error).cause).toBe(failure);
    expect(reads).toBeLessThan(10);
  } finally {
    vi.useRealTimers();
  }
});

it('reports a terminal that never shows a Pi foreground before the whole budget', async () => {
  let reads = 0;

  const read = async (): Promise<readonly string[] | undefined> => {
    reads += 1;

    return ['bash'];
  };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const reading = readStartedModel({
      readForegroundArgv: read,
      terminal: 't-new',
      model: undefined,
      message: undefined,
      signal: undefined,
      deadline: Date.now() + 30_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(readbackNoForegroundBudgetMilliseconds - 1_000);

    expect(await Promise.race([reading, Promise.resolve('waiting' as const)])).toBe('waiting');

    await vi.advanceTimersByTimeAsync(2_000);

    const outcome = await Promise.race([reading, Promise.resolve('waiting' as const)]);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('The started model on terminal t-new is unknown');
    expect(reads).toBeGreaterThan(1);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps polling for a Pi foreground past the no-foreground budget', async () => {
  const startedAt = Date.now();

  const read = async (): Promise<readonly string[] | undefined> =>
    Date.now() - startedAt < 20_000 ? undefined : ['pi'];

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const reading = readStartedModel({
      readForegroundArgv: read,
      terminal: 't-new',
      model: undefined,
      message: undefined,
      signal: undefined,
      deadline: Date.now() + 30_000,
    });

    await vi.advanceTimersByTimeAsync(25_000);

    expect(await reading).toBe('default');
  } finally {
    vi.useRealTimers();
  }
});

it('reads the default model when the task message starts with a model flag', async () => {
  const model = await readStartedModel({
    readForegroundArgv: async () => ['pi', '--model=other'],
    terminal: 't-new',
    model: undefined,
    message: '--model=other',
    signal: undefined,
    deadline: Date.now() + 30_000,
  });

  expect(model).toBe('default');
});

it('keeps an earlier read failure when a later read uses the rest of the budget', async () => {
  const failure = new Error('read failed once');
  let reads = 0;

  const read = (): Promise<readonly string[] | undefined> => {
    reads += 1;

    return reads === 1 ? Promise.reject(failure) : new Promise(() => {});
  };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const reading = readStartedModel({
      readForegroundArgv: read,
      terminal: 't-new',
      model: undefined,
      message: undefined,
      signal: undefined,
      deadline: Date.now() + 1_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);

    const outcome = await reading;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('A read failed: read failed once');
    expect((outcome as Error).cause).toBe(failure);
  } finally {
    vi.useRealTimers();
  }
});
