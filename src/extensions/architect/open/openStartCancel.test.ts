import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import { useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { appCommands, open, openRequest, openTool } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openArchitect, openKeptClaimMessage } from './open.js';
import type { OpenRequest } from './open.js';

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

const requestFor = (
  root: string,
  location: OpenRequest['location'],
  hc: OpenRequest['hc'],
): OpenRequest => ({
  root,
  leadTerminal: 't-lead',
  request: openRequest,
  location,
  ui: { notify: vi.fn<() => void>() },
  hc,
});

const endedWait = (terminal: string, ended: boolean): string => {
  const reason = ended ? 'ended' : 'timeout';
  const exitCode = ended ? 0 : null;

  return JSON.stringify({ terminal, ended, reason, turn: 1, children: [], exit_code: exitCode });
};

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
  const { hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const cancellation = new Error('cancelled after the valid reply');
  const replied = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      replied.resolve(undefined);
      await release.promise;

      return succeededResult('{"pane":"p-architect","terminal":"t-architect"}');
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

it('an abort after preparation starts no launch and releases the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const cancellation = new Error('cancelled before dispatch');

  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    const result = await runtime.exec(command, commandArguments, options);

    if (command === 'herdr-app' && commandArguments[0] === 'ls') {
      controller.abort(cancellation);
    }

    return result;
  };

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec, signal: controller.signal }),
  ).catch((error: unknown) => error);

  expect(failure).toBe(cancellation);
  expect(appCommands(app)).toEqual(['ls']);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('an abort while the takeover sleep waits rejects without the sleep timer', async ({
  onTestFinished: cleanup,
}) => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  const { root, config } = await setup(cleanup);
  const { hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const cancellation = new Error('cancelled in the sleep');

  await recordSession(root);
  hc.reply('kill', JSON.stringify({ address: 't-architect', state: 'finished' }));
  hc.reply('wait', endedWait('t-architect', true));

  const opening = openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  await sleepEntered.current.promise;
  controller.abort(cancellation);

  await expect(opening).resolves.toBe(cancellation);
});
