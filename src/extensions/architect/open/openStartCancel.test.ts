import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import { useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { launchTimeoutMilliseconds } from '../../../piStart/piStart.js';
import {
  appCommands,
  open,
  openRequest,
  openTool,
  requestFor,
  startedTerminalResult,
} from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openArchitect, openKeptClaimMessage } from './open.js';

const sleepEntered = vi.hoisted(() => ({ current: Promise.withResolvers<undefined>() }));

vi.mock(import('node:timers/promises'), async (importOriginal) => {
  const original = await importOriginal();
  const { globalTimerDelay } = await import('../../../../tests/timerFake.js');

  const delay = (<T>(milliseconds?: number, value?: T, options?: { signal?: AbortSignal }) => {
    sleepEntered.current.resolve(undefined);

    return globalTimerDelay(milliseconds, value, options);
  }) as typeof original.setTimeout;

  return { ...original, setTimeout: delay };
});

beforeEach(() => {
  sleepEntered.current = Promise.withResolvers<undefined>();
});

afterEach(() => {
  vi.useRealTimers();
});

const expectCancelled = (failure: unknown, reason: unknown): void => {
  if (reason instanceof Error) {
    expect(failure).toBe(reason);

    return;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('The open was cancelled.');
  expect((failure as Error).cause).toBe(reason);
};

it('an abort during the model readback rejects with the cancellation error', async ({
  onTestFinished: cleanup,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  const { root, config } = await setup(cleanup);
  const { terminals, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const cancellation = new Error('cancelled during the readback');
  const readbackStarted = Promise.withResolvers<undefined>();

  const nonPiForeground = succeededResult(
    JSON.stringify({
      address: 't-architect',
      state: 'live',
      foreground: { pid: 1, name: 'bash', argv: ['bash'], cwd: '' },
    }),
  );

  const processControl = useFakeStartProcess(cleanup, 'running', true);
  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    const result = await runtime.exec(command, commandArguments, options);

    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      terminals.set('t-architect', nonPiForeground);
    }

    const readingStartedTerminal =
      command === 'hc' &&
      commandArguments[0] === 'get' &&
      commandArguments.at(-1) === 't-architect';

    if (readingStartedTerminal) {
      readbackStarted.resolve(undefined);
    }

    return result;
  };

  const opening = openArchitect(
    requestFor(root, config.location, { ...runtime, exec, signal: controller.signal }),
  ).catch((error: unknown) => error);

  await readbackStarted.promise;
  controller.abort(cancellation);

  await vi.advanceTimersByTimeAsync(launchTimeoutMilliseconds);

  const failure = await opening;

  expectCancelled(failure, cancellation);
  expect(processControl.signals).toEqual(['SIGTERM']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('an abort during the poll stops the terminal, releases the claim, and rejects', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const cancellation = new Error('cancelled during the poll');
  const processControl = useFakeStartProcess(cleanup, 'running', true);

  await recordSession(root);

  const opening = openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  await vi.waitFor(() => {
    expect(appCommands(app)).toContain('pane.split');
  });

  controller.abort(cancellation);

  const failure = await opening;

  expect(failure).toBe(cancellation);

  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
  expect(processControl.signals).toEqual(['SIGTERM']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('an abort during the poll keeps the claim and throws the kept-claim message when the terminal does not end', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();

  useFakeStartProcess(cleanup, 'unknown');
  await recordSession(root);

  const opening = openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  await vi.waitFor(() => {
    expect(appCommands(app)).toContain('pane.split');
  });

  controller.abort(new Error('cancelled during the poll'));

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(openKeptClaimMessage(root));
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('a later open reports the kept claim instead of an in-flight start', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();

  useFakeStartProcess(cleanup, 'unknown');
  await recordSession(root);

  const opening = openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  await vi.waitFor(() => {
    expect(appCommands(app)).toContain('pane.split');
  });

  controller.abort(new Error('cancelled during the poll'));

  const failure = await opening;

  expect((failure as Error).message).toBe(openKeptClaimMessage(root));

  const later = await openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  expect(later).toBeInstanceOf(Error);
  expect((later as Error).message).toBe(openKeptClaimMessage(root));
});

it('resolves an unused ticket when a valid reply arrives before the rename and a retry starts', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { hc, runtime, terminals } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const cancellation = new Error('cancelled after the valid reply');
  const replied = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      replied.resolve(undefined);
      await release.promise;

      return startedTerminalResult(terminals, commandArguments);
    }

    return runtime.exec(command, commandArguments, options);
  };

  const opening = openArchitect(
    requestFor(root, config.location, { ...runtime, exec, signal: controller.signal }),
  ).catch((error: unknown) => error);

  await replied.promise;

  const names = await readdir(join(root, '.tau', 'architect', 'start'));

  expect(names.some((name) => name.includes('.started.'))).toBe(false);

  release.resolve(undefined);
  await sleepEntered.current.promise;
  controller.abort(cancellation);

  const failure = await opening;

  expect(failure).toBe(cancellation);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(await readdir(join(root, '.tau', 'architect', 'start'))).toEqual([]);

  const retry = openTool(root);
  const result = await open(retry.tool, root, { request: openRequest });

  expect(result.details).toMatchObject({ status: 'resumed' });
  expect(appCommands(retry.app)).toContain('pane.split');
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
});

it('an abort after the takeover rejects and leaves the architect running', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const controller = new AbortController();

  const { app, hc, runtime } = openTool(root, undefined, undefined, {
    afterTakeover: () => {
      controller.abort(new Error('cancelled after the takeover'));
    },
  });

  await recordSession(root);

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(appCommands(app)).toContain('pane.split');
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);

  expect(await readLiveLockHolder(architectLockPath(root))).toMatchObject({
    terminal: 't-architect',
  });
});

it.each([
  ['an Error reason', () => new Error('cancelled before dispatch')],
  ['a non-Error reason', () => 'cancelled before dispatch'],
])(
  'an abort with %s after preparation starts no launch and releases the claim',
  async (_, reasonOf) => {
    const { root, config } = await setup(onTestFinished);
    const { app, hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
    const controller = new AbortController();
    const reason: unknown = reasonOf();

    await recordSession(root);

    const exec: typeof runtime.exec = async (command, commandArguments, options) => {
      const result = await runtime.exec(command, commandArguments, options);

      if (command === 'herdr-app' && commandArguments[0] === 'ls') {
        controller.abort(reason);
      }

      return result;
    };

    const failure = await openArchitect(
      requestFor(root, config.location, { ...runtime, exec, signal: controller.signal }),
    ).catch((error: unknown) => error);

    expectCancelled(failure, reason);
    expect(appCommands(app)).toEqual(['ls']);
    expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
    expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  },
);

it.each([
  ['an Error reason', () => new Error('cancelled in the sleep')],
  ['a non-Error reason', () => 'cancelled in the sleep'],
])('an abort with %s while the takeover sleep waits rejects with an Error', async (_, reasonOf) => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  const { root, config } = await setup(onTestFinished);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const reason: unknown = reasonOf();

  const child = useFakeStartProcess(onTestFinished, 'running');
  await recordSession(root);

  const opening = openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  await sleepEntered.current.promise;

  child.state = 'gone';

  controller.abort(reason);

  expectCancelled(await opening, reason);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
