import { array, constantFrom, sample, tuple } from 'fast-check';
import { expect, it, vi } from 'vitest';

import { resolvePropertySeed } from '../../../tests/propertySeedHarness.js';
import {
  readStartedModel,
  readbackFailureBudgetMilliseconds,
  readbackNoForegroundBudgetMilliseconds,
} from './startedModelReadback.js';

const neverResolves = new Promise<readonly string[] | undefined>(() => {});

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

it('reports a permanent read failure after the failure budget, not the whole budget', async () => {
  const failure = new Error('spawn hc ENOENT');
  const startedAt = Date.now();
  let settledAt = 0;

  const read = (): Promise<readonly string[] | undefined> => Promise.reject(failure);

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const reading = readStartedModel({
      readForegroundArgv: read,
      terminal: 't-new',
      model: undefined,
      message: undefined,
      signal: undefined,
      deadline: startedAt + 30_000,
    }).then(
      (value) => {
        settledAt = Date.now();

        return value;
      },
      (error: unknown) => {
        settledAt = Date.now();

        return error;
      },
    );

    await vi.advanceTimersByTimeAsync(readbackFailureBudgetMilliseconds + 1_000);

    const outcome = await reading;
    const elapsed = settledAt - startedAt;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('spawn hc ENOENT');
    expect((outcome as Error).message).not.toContain('may still be running');
    expect((outcome as Error).cause).toBe(failure);
    expect(elapsed).toBeGreaterThanOrEqual(readbackFailureBudgetMilliseconds);
    expect(elapsed).toBeLessThan(30_000);
  } finally {
    vi.useRealTimers();
  }
});

it('reports an unreadable model after one read and no cause', async () => {
  let reads = 0;

  const read = async (): Promise<readonly string[] | undefined> => {
    reads += 1;

    return ['pi', '--model', '--provider', 'x'];
  };

  const outcome = await readStartedModel({
    readForegroundArgv: read,
    terminal: 't-new',
    model: undefined,
    message: undefined,
    signal: undefined,
    deadline: Date.now() + 30_000,
  }).catch((error: unknown) => error);

  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toBe('The started model on terminal t-new is unknown.');
  expect((outcome as Error).cause).toBeUndefined();
  expect(reads).toBe(1);
});

it('names a read that timed out when the deadline ends the poll', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const reading = readStartedModel({
      readForegroundArgv: () => neverResolves,
      terminal: 't-new',
      model: undefined,
      message: undefined,
      signal: undefined,
      deadline: Date.now() + 1_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);

    const outcome = await reading;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('the read timed out');
    expect((outcome as Error).cause).toBeInstanceOf(Error);
  } finally {
    vi.useRealTimers();
  }
});

it('removes its abort listener when a read times out', async () => {
  const controller = new AbortController();
  const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const reading = readStartedModel({
      readForegroundArgv: () => neverResolves,
      terminal: 't-new',
      model: undefined,
      message: undefined,
      signal: controller.signal,
      deadline: Date.now() + 1_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);
    await reading;

    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  } finally {
    removeListener.mockRestore();
    vi.useRealTimers();
  }
});

it('keeps the caller deadline when a wrapper follows an early non-Pi foreground', async () => {
  const startedAt = Date.now();
  const wrapper = ['sh', '-c', 'exec "$@"'];
  let reads = 0;

  const read = async (): Promise<readonly string[] | undefined> => {
    reads += 1;

    if (reads === 1) {
      return ['bash'];
    }

    return Date.now() - startedAt < 20_000 ? wrapper : ['pi'];
  };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const reading = readStartedModel({
      readForegroundArgv: read,
      terminal: 't-new',
      model: undefined,
      message: undefined,
      signal: undefined,
      deadline: startedAt + 30_000,
    });

    await vi.advanceTimersByTimeAsync(25_000);

    expect(await reading).toBe('default');
  } finally {
    vi.useRealTimers();
  }
});

it('backs off between reads instead of polling every 100 ms', async () => {
  const readTimes: number[] = [];

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const startedAt = Date.now();

    const read = async (): Promise<readonly string[] | undefined> => {
      readTimes.push(Date.now() - startedAt);

      return undefined;
    };

    const reading = readStartedModel({
      readForegroundArgv: read,
      terminal: 't-new',
      model: undefined,
      message: undefined,
      signal: undefined,
      deadline: startedAt + 30_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);

    expect(readTimes.length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await reading).toBeInstanceOf(Error);

    const gaps = readTimes
      .slice(1)
      .map((readTime, index) => readTime - (readTimes[index] ?? readTime));

    expect(gaps.slice(0, 3)).toEqual([100, 200, 400]);
    expect(Math.max(...gaps)).toBe(1000);
    expect(readTimes.length).toBeLessThan(60);
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

it.each<[string, readonly string[]]>([
  ['a shell wrapper', ['sh', '-c', 'mv -- "$1" "$1.started.$$" || exit 75; shift; exec "$@"']],
  ['a shell wrapper with a combined -ec flag', ['bash', '-ec', 'exec "$@"']],
  ['an ash shell wrapper', ['ash', '-c', 'exec "$@"']],
  ['a mksh shell wrapper', ['mksh', '-c', 'exec "$@"']],
  ['an upper-case shell wrapper', ['BASH.EXE', '-c', 'exec "$@"']],
])('keeps the caller deadline while %s may still start Pi', async (_label, wrapper) => {
  const startedAt = Date.now();

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

it('keeps the non-Pi foreground budget across a read that times out', async () => {
  const startedAt = Date.now();
  let settledAt = 0;
  let reads = 0;

  const read = (): Promise<readonly string[] | undefined> => {
    reads += 1;

    return reads === 1 ? Promise.resolve(['bash']) : neverResolves;
  };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const reading = readStartedModel({
      readForegroundArgv: read,
      terminal: 't-new',
      model: undefined,
      message: undefined,
      signal: undefined,
      deadline: startedAt + 30_000,
    }).then(
      (value) => {
        settledAt = Date.now();

        return value;
      },
      (error: unknown) => {
        settledAt = Date.now();

        return error;
      },
    );

    await vi.advanceTimersByTimeAsync(readbackNoForegroundBudgetMilliseconds + 1_000);

    const outcome = await reading;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('The started model on terminal t-new is unknown');
    expect((outcome as Error).message).toContain('A read failed: the read timed out');

    const elapsed = settledAt - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(readbackNoForegroundBudgetMilliseconds);
    expect(elapsed).toBeLessThan(30_000);
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
