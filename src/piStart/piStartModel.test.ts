import { expect, it, onTestFinished, vi } from 'vitest';

import { createExecFake, succeededResult } from '../../tests/execFake.js';
import type { ExecFake } from '../../tests/execFake.js';
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
  startPiSession,
} from './piStart.js';

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
): ExecFake<'launch' | 'get'> => {
  const getReply = JSON.stringify({
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
      key === 'launch' ? () => succeededResult(reply) : () => succeededResult(getReply),
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

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), { model: 'morph/morph-dsv41flash-1017' }),
  );

  expect(result.model).toBe('morph/morph-dsv41flash-1017');
});

it.each([
  {
    name: 'a pi path',
    argv: ['/usr/bin/pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a node pi path',
    argv: ['node', '/usr/local/bin/pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a node pi path with a leading flag',
    argv: [
      'node',
      '--experimental-strip-types',
      '/path/pi',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a node pi path with a value-taking flag before the script',
    argv: [
      'node',
      '--loader',
      'tsx',
      '/path/pi',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a node pi path after a value-taking flag',
    argv: [
      'node',
      '--stack-size',
      '2000',
      '/path/pi',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a node pi.js script after a value-taking flag',
    argv: [
      'node',
      '--stack-size',
      '2000',
      'pi.js',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a bare pi script after the runtime',
    argv: ['node', 'pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a bare pi after an attached flag',
    argv: [
      'node',
      '--require=./setup.js',
      'pi',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a bare pi after a loader flag',
    argv: [
      'node',
      '--loader',
      'tsx',
      'pi',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a bare pi after a memory flag',
    argv: [
      'node',
      '--max-old-space-size',
      '4096',
      'pi',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a bun pi path',
    argv: ['bun', '/path/pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a bun.exe pi path',
    argv: ['bun.exe', '/path/pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a node.exe pi.cmd path',
    argv: [
      'node.exe',
      '/usr/local/bin/pi.cmd',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
])('a start reads the model from $name', async ({ argv }) => {
  const fake = launchWithForeground(argv);
  const root = await createTemporaryRepository(onTestFinished);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  try {
    const opening = startPiSession(
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

it.each<[string, readonly string[] | undefined]>([
  ['undefined', undefined],
  ['a non-Pi argv', ['bash']],
  ['a node command with a trailing pi argument', ['node', '/path/tool.js', 'pi']],
  ['a node command with a flag value of pi', ['node', '--title', 'pi', '/path/tool.js']],
  ['a node command with a Pi-named flag value', ['node', '--require', './pi.js', 'main.js']],
  ['a bare pi argument after an unknown value-taking flag', ['node', '--stack-size', '2000', 'pi']],
  ['a node eval command with a trailing pi', ['node', '-e', 'code', 'pi']],
  ['a node eval command with a path-shaped pi after the code', ['node', '-e', 'code', '/path/pi']],
  ['a node print command with a trailing pi', ['node', '--print', 'code', 'pi']],
  ['a node long eval command with a trailing pi', ['node', '--eval', 'code', 'pi']],
  ['a node short print command with a trailing pi', ['node', '-p', 'code', 'pi']],
  [
    'a node long eval command with an inline code value and a trailing pi',
    ['node', '--eval=code', 'pi'],
  ],
  [
    'a node long print command with an inline code value and a trailing pi',
    ['node', '--print=code', 'pi'],
  ],
])('a start retries a model read that first returns %s', async (_shape, firstRead) => {
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

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, reader, { model: 'morph/morph-dsv41flash-1017' }),
  );

  expect(result.model).toBe('morph/morph-dsv41flash-1017');
  expect(reads).toBe(2);
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

  const failure = await startPiSession(
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  try {
    const opening = startPiSession(
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
    expect(message).toContain('It may still be running');
  } finally {
    vi.useRealTimers();
  }
});

it('an abort during the model readback ends the call', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();
  const cancellation = new Error('cancelled during the readback');

  const opening = startPiSession(
    { exec: fake.exec, cwd: root, signal: controller.signal },
    startRequest(root, neverReads),
  ).catch((error: unknown) => error);

  await vi.waitFor(() => {
    expect(fake.calls).toHaveLength(1);
  });

  controller.abort(cancellation);

  expect(await opening).toBe(cancellation);
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

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  try {
    const opening = startPiSession(
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

it('a model read that times out removes its abort listener', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();
  const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  try {
    const opening = startPiSession(
      { exec: fake.exec, cwd: root, signal: controller.signal },
      startRequest(root, neverReads),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(fake.calls).toHaveLength(1);
    });

    await vi.advanceTimersByTimeAsync(launchTimeoutMilliseconds);

    expect(await opening).toBeInstanceOf(Error);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  } finally {
    removeListener.mockRestore();
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

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, reader, { model: 'morph/morph-dsv41flash-1017' }),
  );

  expect(result.model).toBe('morph/morph-dsv41flash-1017');
  expect(reads).toBe(3);
});

it('a start backs off between model reads instead of polling every 100 ms', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const readTimes: number[] = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  try {
    const startedAt = Date.now();

    const reader = async (): Promise<readonly string[] | undefined> => {
      readTimes.push(Date.now() - startedAt);

      return undefined;
    };

    const opening = startPiSession(
      { exec: fake.exec, cwd: root },
      startRequest(root, reader),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(readTimes.length).toBeGreaterThan(0);
    });

    await vi.advanceTimersByTimeAsync(launchTimeoutMilliseconds);

    expect(await opening).toBeInstanceOf(Error);

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
