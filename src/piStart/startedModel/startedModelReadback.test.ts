import { array, constantFrom, sample, tuple } from 'fast-check';
import { expect, it, vi } from 'vitest';

import { resolvePropertySeed } from '../../../tests/propertySeedHarness.js';
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

it('keeps the caller deadline while a shell wrapper foreground may still start Pi', async () => {
  const startedAt = Date.now();
  const wrapper = ['sh', '-c', 'mv -- "$1" "$1.started.$$" || exit 75; shift; exec "$@"'];

  const read = async (): Promise<readonly string[] | undefined> =>
    Date.now() - startedAt < 20_000 ? wrapper : ['pi'];

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

// fast-check's async property scheduler uses timers, which the fake timers here intercept, so the
// scenarios are generated up front and driven one at a time.
it('never retries a decided read and always ends the poll on an abort', async () => {
  const seed = resolvePropertySeed();

  const scenarios = sample(
    tuple(array(constantFrom('none', 'bash'), { maxLength: 3 }), constantFrom('pi', 'abort')),
    { seed, numRuns: 30 },
  );

  for (const [prefix, final] of scenarios) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

    try {
      const controller = new AbortController();
      const cancellation = new Error('cancelled');
      const deadline = Date.now() + 30_000;
      let reads = 0;

      const read = async (): Promise<readonly string[] | undefined> => {
        reads += 1;

        const step = prefix[reads - 1];

        if (step === undefined) {
          return ['pi', '--provider', 'p', '--model', 'm'];
        }

        if (final === 'abort' && reads === prefix.length) {
          controller.abort(cancellation);
        }

        return step === 'none' ? undefined : ['bash'];
      };

      if (final === 'abort' && prefix.length === 0) {
        controller.abort(cancellation);
      }

      let settledAt = 0;

      const reading = readStartedModel({
        readForegroundArgv: read,
        terminal: 't-new',
        model: 'p/m',
        message: undefined,
        signal: controller.signal,
        deadline,
      }).then(
        (value) => {
          settledAt = Date.now();

          return value;
        },
        (error: unknown) => {
          settledAt = Date.now();

          return error instanceof Error ? error : new Error(String(error));
        },
      );

      // The readback deadline is 30 seconds, so this many steps must settle every scenario.
      for (let step = 0; step < 61; step += 1) {
        await vi.advanceTimersByTimeAsync(500);
      }

      const outcome = await reading;

      const expectedOutcome = final === 'pi' ? 'p/m' : cancellation;
      const expectedReads = final === 'pi' ? prefix.length + 1 : prefix.length;

      expect(settledAt).toBeLessThanOrEqual(deadline);
      expect(outcome).toBe(expectedOutcome);
      expect(reads).toBe(expectedReads);
    } finally {
      vi.useRealTimers();
    }
  }
});
