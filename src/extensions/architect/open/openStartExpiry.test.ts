import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import { holdFileLock, readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { appCommands, open, openRequest, openTool } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openArchitect, openKeptClaimMessage, startingError, takeoverExpiryError } from './open.js';
import type { OpenRequest } from './open.js';

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

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(takeoverExpiryError().message);
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

  retry.app.overrideOutput('space.new', '{"space":"sp-2","tab":"tb-2","terminal":"t-space-2"}');

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

it('keeps the claim when the space reply has no terminal and the lookup fails', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);

  const { app, hc, tool } = openTool(root, { space: undefined }, undefined, {
    takeover: false,
  });

  app.overrideOutput('space.new', '{"ok":true}');
  hc.fail('ls', 'hc ls failed', 1);

  const failure = await open(tool, root, { request: openRequest }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(openKeptClaimMessage(root));
  expect(killCalls(hc.calls)).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
    startingError(root).message,
  );
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

it('stops a split whose reply fails its schema before releasing the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const waitEntered = Promise.withResolvers<undefined>();
  const waitRelease = Promise.withResolvers<undefined>();
  let waits = 0;

  app.overrideOutput('pane.split', '{"pane":"p-architect"}');
  await recordSession(root);
  hc.reply('ls', JSON.stringify({ terminals: [{ address: 't-architect', state: 'live' }] }));
  hc.reply('kill', JSON.stringify({ address: 't-architect', state: 'finished' }));
  hc.reply('wait', endedWait('t-architect', true));

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (
      command === 'hc' &&
      commandArguments[0] === 'get' &&
      commandArguments.at(-1) === 't-architect'
    ) {
      const holder = await readLiveLockHolder(architectLockPath(root));
      const argv = ['env', `TAU_ARCHITECT_CLAIM=${holder?.token ?? ''}`, 'pi'];

      return succeededResult(JSON.stringify({ address: 't-architect', state: 'live', argv }));
    }

    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      if (waits === 1) {
        waitEntered.resolve(undefined);
        await waitRelease.promise;
      }
    }

    return runtime.exec(command, commandArguments, options);
  };

  const request = requestFor(root, config.location, { ...runtime, exec });
  const opening = openArchitect(request).catch((error: unknown) => error);

  await waitEntered.promise;

  await expect(openArchitect(request)).rejects.toThrow(startingError(root).message);

  waitRelease.resolve(undefined);

  const failure = await opening;

  const splits = appCommands(app).filter((name) => name === 'pane.split');

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('herdr-app do pane.split');
  expect(killCalls(hc.calls)).toEqual([['kill', '--json', '--', 't-architect']]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(splits).toHaveLength(1);
});

it('returns the normal result when a space reply has no terminal but the child adopts its claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);

  const { app, hc, runtime } = openTool(root, { space: undefined }, undefined, {
    takeover: false,
  });

  app.overrideOutput('space.new', '{"ok":true}');
  const sessionFile = await recordSession(root);

  hc.reply('ls', JSON.stringify({ terminals: [{ address: 't-space', state: 'live' }] }));
  let launchedClaim: string | undefined;

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (
      command === 'hc' &&
      commandArguments[0] === 'get' &&
      commandArguments.at(-1) === 't-space'
    ) {
      const argv = ['env', `TAU_ARCHITECT_CLAIM=${launchedClaim ?? ''}`, 'pi'];

      return succeededResult(JSON.stringify({ address: 't-space', state: 'live', argv }));
    }

    return runtime.exec(command, commandArguments, options);
  };

  const appExec: typeof app.exec = async (command, commandArguments, options) => {
    const result = await app.exec(command, commandArguments, options);

    if (commandArguments[1] === 'space.new') {
      const holder = await readLiveLockHolder(architectLockPath(root));

      launchedClaim = holder?.token;

      if (holder !== undefined) {
        const held = await holdFileLock({
          lockPath: architectLockPath(root),
          checkout: root,
          terminal: 't-space',
          token: 'adopted',
          adopt: holder.token,
        });

        if (held.kind === 'held') {
          cleanup(held.release);
        }
      }
    }

    return result;
  };

  const routedExec: typeof runtime.exec = async (command, commandArguments, options) =>
    command === 'herdr-app'
      ? appExec(command, commandArguments, options)
      : exec(command, commandArguments, options);

  const result = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec: routedExec }),
  );

  const spaces = appCommands(app).filter((name) => name === 'space.new');

  expect(result).toEqual({ status: 'resumed', sessionFile });
  expect(killCalls(hc.calls)).toEqual([]);
  expect(spaces).toHaveLength(1);
});

it('releases the claim after the lookup finds no terminal for ten seconds', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);

  const { app, hc, runtime } = openTool(root, { space: undefined }, undefined, {
    takeover: false,
  });

  app.overrideOutput('space.new', '{"ok":true}');
  await recordSession(root);
  hc.reply('ls', JSON.stringify({ terminals: [] }));
  startFakeTimers();

  const opening = openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(10_000);

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('herdr-app do');
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it.each([
  { name: 'not JSON', reply: 'not json' },
  { name: 'JSON null', reply: 'null' },
  { name: 'a JSON array', reply: '[]' },
  { name: 'a non-string terminal', reply: '{"terminal":42}' },
  { name: 'a null terminal', reply: '{"terminal":null}' },
  { name: 'an empty terminal', reply: '{"terminal":""}' },
])(
  'releases only after the lookup confirms no terminal for a reply with $name',
  async ({ reply }) => {
    const { root, config } = await setup(onTestFinished);

    const { app, hc, runtime } = openTool(root, { space: undefined }, undefined, {
      takeover: false,
    });

    app.overrideOutput('space.new', reply);
    await recordSession(root);
    hc.reply('ls', JSON.stringify({ terminals: [] }));
    startFakeTimers();

    const opening = openArchitect(requestFor(root, config.location, runtime)).catch(
      (error: unknown) => error,
    );

    await poll.started.promise;
    await vi.advanceTimersByTimeAsync(10_000);

    const failure = await opening;

    expect(failure).toBeInstanceOf(Error);
    expect(killCalls(hc.calls)).toEqual([]);
    expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  },
);

it('reports a launch failure after the lookup confirms no terminal', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, hc, runtime } = openTool(root, undefined, undefined, { takeover: false });

  app.failCommand('pane.split', 'pane p-lead is gone');
  await recordSession(root);
  hc.reply('ls', JSON.stringify({ terminals: [] }));
  startFakeTimers();

  const opening = openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(10_000);

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('pane p-lead is gone');
  expect((failure as Error).message).not.toBe(takeoverExpiryError().message);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
