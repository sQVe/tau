import { expect, it, onTestFinished, vi } from 'vitest';

import { createExecFake, failedResult, succeededResult } from '../../tests/execFake.js';
import type { ExecFake, ExecResult } from '../../tests/execFake.js';
import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { createHerdrAppFake } from '../../tests/herdrAppFake.js';
import {
  launchRequest,
  paneRequest,
  readerFor,
  startRequest,
} from '../../tests/piStartRequests.js';
import {
  launchPiSession,
  launchPiSessionRightOf,
  launchTimeoutMilliseconds,
  startPiSessionWithTerminal,
} from './piStart.js';
import { readbackFailureBudgetMilliseconds } from './startedModel/startedModelReadback.js';

const neverResolves = new Promise<readonly string[] | undefined>(() => {});
const neverReads = (): Promise<readonly string[] | undefined> => neverResolves;

vi.mock(import('node:timers/promises'), async (importOriginal) => {
  const original = await importOriginal();
  const { globalTimerDelay } = await import('../../tests/timerFake.js');

  return { ...original, setTimeout: globalTimerDelay };
});

const launchWithForeground = (
  argv: string[],
  reply = '{"space":"sp-new","tab":"tb-new","terminal":"t-new"}',
  getReply?: () => ExecResult,
): ExecFake<'launch' | 'get'> => {
  const defaultGetReply = JSON.stringify({
    address: 't-new',
    state: 'live',
    foreground: { pid: 1, name: 'pi', argv, cwd: '/tmp' },
  });

  return createExecFake<'launch' | 'get'>({
    keyOf: (command, commandArguments) => {
      if (command === 'herdr-app') {
        return 'launch';
      }

      return command === 'hc' && commandArguments[0] === 'get' ? 'get' : undefined;
    },
    handlerFor: (key) =>
      key === 'launch'
        ? () => succeededResult(reply)
        : () => getReply?.() ?? succeededResult(defaultGetReply),
  });
};

it('a start returns the model its terminal runs', async () => {
  const fake = launchWithForeground([
    'pi',
    '--provider',
    'morph',
    '--model',
    'morph-dsv41flash-1017',
  ]);

  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSessionWithTerminal(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), { model: 'morph/morph-dsv41flash-1017' }),
  );

  expect(result.model).toBe('morph/morph-dsv41flash-1017');
});

it.each([
  {
    name: 'a node pi path',
    argv: ['node', '/usr/local/bin/pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a bun pi path',
    argv: ['bun', '/usr/local/bin/pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a node.exe pi.cmd path',
    argv: ['node.exe', 'C:/pi/pi.cmd', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
])('a start reads the model from $name', async ({ argv }) => {
  const fake = launchWithForeground(argv);
  const root = await createTemporaryRepository(onTestFinished);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const opening = startPiSessionWithTerminal(
      { exec: fake.exec, cwd: root },
      startRequest(root, readerFor(fake, root), { model: 'morph/morph-dsv41flash-1017' }),
    );

    await vi.waitFor(() => {
      expect(fake.calls.length).toBeGreaterThanOrEqual(1);
    });

    await vi.advanceTimersByTimeAsync(launchTimeoutMilliseconds);

    const result = await opening;

    expect(result.model).toBe('morph/morph-dsv41flash-1017');
  } finally {
    vi.useRealTimers();
  }
});

it('a start retries a model read that first returns a non-Pi argv', async () => {
  const firstRead = ['bash'];

  const fake = launchWithForeground([
    'pi',
    '--provider',
    'morph',
    '--model',
    'morph-dsv41flash-1017',
  ]);

  const root = await createTemporaryRepository(onTestFinished);
  let reads = 0;

  const reader = async (): Promise<readonly string[] | undefined> => {
    reads += 1;

    return reads === 1
      ? firstRead
      : ['pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'];
  };

  const result = await startPiSessionWithTerminal(
    { exec: fake.exec, cwd: root },
    startRequest(root, reader, { model: 'morph/morph-dsv41flash-1017' }),
  );

  expect(result.model).toBe('morph/morph-dsv41flash-1017');
  expect(reads).toBe(2);
});

it('a start retries a model read that fails once before answering', async () => {
  const fake = launchWithForeground([
    'pi',
    '--provider',
    'morph',
    '--model',
    'morph-dsv41flash-1017',
  ]);

  const root = await createTemporaryRepository(onTestFinished);
  let reads = 0;

  const reader = async (): Promise<readonly string[] | undefined> => {
    reads += 1;

    if (reads === 1) {
      throw new Error('the terminal is not registered yet');
    }

    return ['pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'];
  };

  const result = await startPiSessionWithTerminal(
    { exec: fake.exec, cwd: root },
    startRequest(root, reader, { model: 'morph/morph-dsv41flash-1017' }),
  );

  expect(result.model).toBe('morph/morph-dsv41flash-1017');
  expect(reads).toBe(2);
});

it('a start keeps reading a terminal that is not registered yet past the failure budget', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const notFoundReply = JSON.stringify({
    error: { kind: 'not_found', message: 'no terminal "t-new"' },
  });

  const foregroundReply = JSON.stringify({
    address: 't-new',
    state: 'live',
    foreground: {
      pid: 1,
      name: 'pi',
      argv: ['pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
      cwd: root,
    },
  });

  let registered = false;

  const fake = launchWithForeground(
    ['pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
    undefined,
    () => (registered ? succeededResult(foregroundReply) : failedResult(notFoundReply, 3)),
  );

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const opening = startPiSessionWithTerminal(
      { exec: fake.exec, cwd: root },
      startRequest(root, readerFor(fake, root), { model: 'morph/morph-dsv41flash-1017' }),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(fake.calls.some(({ command }) => command === 'hc')).toBe(true);
    });

    await vi.advanceTimersByTimeAsync(readbackFailureBudgetMilliseconds + 1_000);

    registered = true;

    await vi.advanceTimersByTimeAsync(2_000);

    const result = await opening;

    expect(result).not.toBeInstanceOf(Error);

    expect((result as Awaited<ReturnType<typeof startPiSessionWithTerminal>>).model).toBe(
      'morph/morph-dsv41flash-1017',
    );
  } finally {
    vi.useRealTimers();
  }
});

it('a start fails when the terminal runs another model', async () => {
  const fake = launchWithForeground([
    'pi',
    '--provider',
    'morph',
    '--model',
    'morph-dsv41flash-1017',
  ]);

  const root = await createTemporaryRepository(onTestFinished);

  const failure = await startPiSessionWithTerminal(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), { model: 'claude-bridge/claude-opus-5-5' }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  const message = (failure as Error).message;

  expect(message).toContain('claude-bridge/claude-opus-5-5');
  expect(message).toContain('morph/morph-dsv41flash-1017');
  expect(message).toContain('t-new');
  expect(message).toContain('hc get t-new');
});

it('a start fails when the terminal never shows a foreground before the deadline', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const opening = startPiSessionWithTerminal(
      { exec: fake.exec, cwd: root },
      startRequest(root, neverReads),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(fake.calls).toHaveLength(1);
    });

    await vi.advanceTimersByTimeAsync(launchTimeoutMilliseconds);

    const failure = await opening;

    expect(failure).toBeInstanceOf(Error);

    const message = (failure as Error).message;

    expect(message).toContain('t-new');
    expect(message).toContain('hc get t-new');
    expect(message).toContain('may still be running');
  } finally {
    vi.useRealTimers();
  }
});

it('an abort during the model readback ends the call', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();
  const cancellation = new Error('cancelled during the readback');

  const opening = startPiSessionWithTerminal(
    { exec: fake.exec, cwd: root, signal: controller.signal },
    startRequest(root, neverReads),
  ).catch((error: unknown) => error);

  await vi.waitFor(() => {
    expect(fake.calls).toHaveLength(1);
  });

  controller.abort(cancellation);

  const failure = await opening;

  expect(failure).toBe(cancellation);
});

it('an abort during the backoff pause ends the call before the next read', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();
  const cancellation = new Error('cancelled during the pause');
  let reads = 0;

  const readsNothing = (): Promise<readonly string[] | undefined> => {
    reads += 1;

    return Promise.resolve(undefined);
  };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const opening = startPiSessionWithTerminal(
      { exec: fake.exec, cwd: root, signal: controller.signal },
      startRequest(root, readsNothing),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(reads).toBe(1);
    });

    controller.abort(cancellation);

    // The pause is the only pending work, so a call that ignores the abort stays in the race.
    const stillWaiting = vi.advanceTimersByTimeAsync(0).then(() => 'still waiting' as const);
    const outcome = await Promise.race([opening, stillWaiting]);

    expect(outcome).toBe(cancellation);
    expect(reads).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it('aborts an in-flight model read when the readback budget expires', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  let readSignal: AbortSignal | undefined;

  const reader = (
    _terminal: string,
    signal?: AbortSignal,
  ): Promise<readonly string[] | undefined> => {
    readSignal = signal;

    return neverResolves;
  };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const opening = startPiSessionWithTerminal(
      { exec: fake.exec, cwd: root },
      startRequest(root, reader),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(fake.calls).toHaveLength(1);
    });

    await vi.waitFor(() => {
      expect(readSignal).toBeDefined();
    });

    await vi.advanceTimersByTimeAsync(launchTimeoutMilliseconds);

    expect(await opening).toBeInstanceOf(Error);
    expect(readSignal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('bounds the launch and the readback with one timeout', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  let launched = false;

  const fake = createExecFake<'launch'>({
    keyOf: (command) => (command === 'herdr-app' ? 'launch' : undefined),
    handlerFor: () => () => {
      vi.setSystemTime(Date.now() + 20_000);
      launched = true;

      return succeededResult('{"space":"sp-1","tab":"tb-1","terminal":"t-space"}');
    },
  });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const opening = startPiSessionWithTerminal(
      { exec: fake.exec, cwd: root },
      startRequest(root, neverReads),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(launched).toBe(true);
    });

    const waiting = vi.advanceTimersByTimeAsync(10_000).then(() => 'waiting' as const);
    const outcome = await Promise.race([opening, waiting]);

    expect(outcome).toBeInstanceOf(Error);

    expect((outcome as Error).message).toContain(
      'The started model on terminal t-space is unknown',
    );
  } finally {
    vi.useRealTimers();
  }
});

it('a slow successful launch still leaves a window to read the model', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const fake = createHerdrAppFake({
    beforeReply: (key) => {
      if (key === 'tab.new' || key === 'space.new') {
        vi.setSystemTime(Date.now() + launchTimeoutMilliseconds);
      }
    },
  });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const result = await startPiSessionWithTerminal(
      { exec: fake.exec, cwd: root },
      startRequest(root, readerFor(fake, root), { model: 'morph/morph-dsv41flash-1017' }),
    );

    expect(result.model).toBe('morph/morph-dsv41flash-1017');
  } finally {
    vi.useRealTimers();
  }
});

it('a launch returns the model its terminal runs', async () => {
  const fake = launchWithForeground(['pi', '--provider', 'a', '--model', 'architect']);
  const root = await createTemporaryRepository(onTestFinished);

  const result = await launchPiSession(
    { exec: fake.exec, cwd: root },
    { ...launchRequest(root, readerFor(fake, root)), model: 'a/architect' },
  );

  expect(result.model).toBe('a/architect');
});

it('a launch returns a readback mismatch as its error', async () => {
  const fake = launchWithForeground(['pi', '--provider', 'a', '--model', 'architect']);
  const root = await createTemporaryRepository(onTestFinished);

  const result = await launchPiSession(
    { exec: fake.exec, cwd: root },
    { ...launchRequest(root, readerFor(fake, root)), model: 'other/model' },
  );

  expect(result.terminal).toBe('t-new');
  expect(result.model).toBeUndefined();
  expect(result.error).toBeInstanceOf(Error);
  expect((result.error as Error).message).toContain('other/model');
  expect((result.error as Error).message).toContain('hc kill t-new');
});

it('a right-of launch returns the model its terminal runs', async () => {
  const fake = launchWithForeground(
    ['pi', '--provider', 'a', '--model', 'architect'],
    '{"pane":"p-new","terminal":"t-new"}',
  );

  const root = await createTemporaryRepository(onTestFinished);

  const result = await launchPiSessionRightOf(
    { exec: fake.exec, cwd: root },
    { ...paneRequest(root, readerFor(fake, root)), model: 'a/architect' },
  );

  expect(result.model).toBe('a/architect');
});

it('a start reports the model when its terminal shows the Pi foreground late', async () => {
  const fake = launchWithForeground([
    'pi',
    '--provider',
    'morph',
    '--model',
    'morph-dsv41flash-1017',
  ]);

  const root = await createTemporaryRepository(onTestFinished);
  let reads = 0;

  const reader = async (): Promise<readonly string[] | undefined> => {
    reads += 1;

    return reads < 3
      ? undefined
      : ['pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'];
  };

  const result = await startPiSessionWithTerminal(
    { exec: fake.exec, cwd: root },
    startRequest(root, reader, { model: 'morph/morph-dsv41flash-1017' }),
  );

  expect(result.model).toBe('morph/morph-dsv41flash-1017');
  expect(reads).toBe(3);
});
