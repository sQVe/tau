import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { appCommands, open, openRequest, openTool } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openKeptClaimMessage, startingError } from './open.js';

const poll = vi.hoisted(() => ({ started: Promise.withResolvers<undefined>() }));

vi.mock(import('node:timers/promises'), async (importOriginal) => {
  const original = await importOriginal();
  const { globalTimerDelay } = await import('../../../../tests/timerFake.js');

  const delay = (<T>(milliseconds?: number, value?: T, options?: { signal?: AbortSignal }) => {
    poll.started.resolve(undefined);

    return globalTimerDelay(milliseconds, value, options);
  }) as typeof original.setTimeout;

  return { ...original, setTimeout: delay };
});

beforeEach(() => {
  poll.started = Promise.withResolvers<undefined>();
});

afterEach(() => {
  vi.useRealTimers();
});

const endedWait = (terminal: string, ended: boolean): string => {
  const reason = ended ? 'ended' : 'timeout';
  const exitCode = ended ? 0 : null;

  return JSON.stringify({ terminal, ended, reason, turn: 1, children: [], exit_code: exitCode });
};

const killCalls = (calls: { commandArguments: string[] }[]): string[][] =>
  calls.filter((call) => call.commandArguments[0] === 'kill').map((call) => call.commandArguments);

const startFakeTimers = (): void => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
};

it('stops the pane terminal at the deadline, releases after it ends, and lets a retry start', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, hc, tool } = openTool(root, undefined, undefined, { takeover: false });

  await recordSession(root);
  hc.reply('kill', JSON.stringify({ address: 't-architect', state: 'finished' }));
  hc.reply('wait', endedWait('t-architect', true));
  startFakeTimers();

  const opening = open(tool, root, { request: openRequest }).catch((error: unknown) => error);

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(60_000);

  expect(await opening).toBeInstanceOf(Error);
  expect(killCalls(hc.calls)).toEqual([['kill', '--json', '--', 't-architect']]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(appCommands(app)).toContain('pane.split');

  vi.useRealTimers();

  const retry = openTool(root);
  const result = await open(retry.tool, root, { request: openRequest });

  expect(result.details).toMatchObject({ status: 'resumed' });
  expect(appCommands(retry.app)).toContain('pane.split');
});

it('stops the space terminal at the deadline, releases after it ends, and lets a retry start', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, hc, tool } = openTool(root, { space: undefined }, undefined, { takeover: false });

  app.overrideOutput('space.new', '{"space":"sp-1","tab":"tb-1","terminal":"t-space"}');
  await recordSession(root);
  hc.reply('kill', JSON.stringify({ address: 't-space', state: 'finished' }));
  hc.reply('wait', endedWait('t-space', true));
  startFakeTimers();

  const opening = open(tool, root, { request: openRequest }).catch((error: unknown) => error);

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(60_000);

  expect(await opening).toBeInstanceOf(Error);
  expect(killCalls(hc.calls)).toEqual([['kill', '--json', '--', 't-space']]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();

  vi.useRealTimers();

  const retry = openTool(root, { space: undefined });
  const result = await open(retry.tool, root, { request: openRequest });

  expect(result.details).toMatchObject({ status: 'resumed' });
});

it('keeps the claim when the pane terminal does not end and refuses a retry as starting', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { hc, tool } = openTool(root, undefined, undefined, { takeover: false });

  hc.reply('kill', JSON.stringify({ address: 't-architect', state: 'finished' }));
  hc.reply('wait', endedWait('t-architect', false));
  startFakeTimers();

  const opening = open(tool, root, { request: openRequest }).catch((error: unknown) => error);

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(60_000);

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(openKeptClaimMessage(root));
  expect(killCalls(hc.calls)).toEqual([['kill', '--json', '--', 't-architect']]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();

  vi.useRealTimers();

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
    startingError(root).message,
  );
});

it('keeps the claim when the space reply has no terminal and refuses a retry as starting', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);

  const { app, hc, tool } = openTool(root, { space: undefined }, undefined, {
    takeover: false,
  });

  app.overrideOutput('space.new', '{"ok":true}');
  startFakeTimers();

  const opening = open(tool, root, { request: openRequest }).catch((error: unknown) => error);

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(60_000);

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(openKeptClaimMessage(root));
  expect(killCalls(hc.calls)).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();

  vi.useRealTimers();

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
    startingError(root).message,
  );
});
