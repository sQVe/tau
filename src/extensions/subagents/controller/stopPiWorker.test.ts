import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { herdrFake } from '../../../../tests/herdrFake.js';
import * as cancellation from '../cancellation.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import { WorkerPlacement } from '../placement.js';
import type { Task } from '../types.js';
import { herdrReply } from './fixtures/herdrReply.js';
import { stopPiWorker } from './stop.js';
import { createHandle } from './task.js';

vi.mock(import('node:timers/promises'), async (importOriginal) => ({
  ...(await importOriginal()),
  setTimeout: (await import('./fixtures/globalTimerDelay.js')).globalTimerDelay,
}));

const token = '/tmp/worker-session.jsonl';
const processId = 4242;
const terminalId = 'pane-terminal';

let fake = herdrFake();

const sessionArguments = ['pi', token];

const seedWorker = (name: string, argv = sessionArguments, workerProcessId = processId) => {
  fake.seedWorker({
    paneId: name,
    terminalId: `${name}-terminal`,
    processId: workerProcessId,
    session: token,
    argv,
  });
};

const client = (argumentsList: string[]) => fake.client(argumentsList, 0);

const closed = () => fake.calls.filter((entry) => entry[1] === 'close');

const newHandle = () => {
  const task = { taskId: 'task', nativeSessionFile: token, loadout: fixtureLoadout('/tmp') };
  const handle = createHandle('/tmp/task', task as Task, performance.now() + 60_000);

  handle.startup.neverStarted = false;

  return handle;
};

const ownedHandle = () => {
  const handle = newHandle();

  handle.identity.terminalId = terminalId;

  handle.identity.owned = {
    version: 2,
    kind: 'pi',
    paneId: 'pane',
    terminalId,
    shellPid: processId,
    processId,
    token,
    startedAt: 'saved start',
  };

  return handle;
};

const unownedHandle = () => {
  const handle = newHandle();

  handle.identity.terminalId = terminalId;

  return handle;
};

const lostReplyHandle = (before: string[] = []) => {
  const handle = newHandle();

  handle.startup.terminalsBeforeLaunch = before;

  return handle;
};

const stop = (
  handle: ReturnType<typeof newHandle>,
  call: (argumentsList: string[]) => Promise<string>,
  options: {
    graceful?: boolean;
    placement?: WorkerPlacement;
    signal?: AbortSignal;
  } = {},
) =>
  stopPiWorker({
    handle,
    call,
    remainingBudget: () => 5000,
    signal: options.signal ?? AbortSignal.timeout(5000),
    placement: options.placement ?? new WorkerPlacement(),
    graceful: options.graceful ?? false,
  });

beforeEach(() => {
  fake = herdrFake();
  vi.spyOn(cancellation, 'runClient').mockResolvedValue('saved start');
  vi.spyOn(cancellation, 'processAbsent').mockImplementation(fake.processAbsent);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('refuses to close a pane when the worker moved during the identity checks', async () => {
  seedWorker('pane');

  let listCalls = 0;

  // The worker moves between the identity checks and the second look at its terminal.
  const call = async (argumentsList: string[]) => {
    listCalls += argumentsList[1] === 'list' ? 1 : 0;

    if (listCalls === 2) {
      fake.move(terminalId);
    }

    return client(argumentsList);
  };

  const outcome = await stop(unownedHandle(), call);

  expect(outcome.stopped).toBe(false);
  expect(closed()).toEqual([]);
});

it('refuses a pane whose process info names another pane', async () => {
  seedWorker('pane');
  fake.malformedEvidence(terminalId, 'processInfo', herdrReply('wrongPaneId.json'));

  const outcome = await stop(unownedHandle(), client);

  expect(outcome.stopped).toBe(false);
  expect(closed()).toEqual([]);
});

it('refuses a pane whose session runs in a process other than the shell', async () => {
  seedWorker('pane');
  fake.malformedEvidence(terminalId, 'processInfo', herdrReply('sessionInAnotherProcess.json'));

  const outcome = await stop(unownedHandle(), client);

  expect(outcome.stopped).toBe(false);
  expect(closed()).toEqual([]);
});

it('closes the new pane that runs the session after a lost launch reply', async () => {
  seedWorker('old', ['pi', 'elsewhere'], 6001);
  seedWorker('other', ['pi', 'elsewhere'], 6002);
  seedWorker('launched');

  const outcome = await stop(lostReplyHandle(['old-terminal']), client);

  expect(outcome.stopped).toBe(true);
  expect(closed()).toEqual([['pane', 'close', 'launched']]);
});

it('skips a new pane whose process info is unreadable after a lost launch reply', async () => {
  seedWorker('unreadable', sessionArguments, 6001);
  seedWorker('launched');
  fake.malformedEvidence('unreadable-terminal', 'processInfo', new Error('process-info failed'));

  const outcome = await stop(lostReplyHandle(), client);

  expect(outcome.stopped).toBe(true);
  expect(closed()).toEqual([['pane', 'close', 'launched']]);
});

it.each([
  ['has no foreground process for the shell', 'noShellProcess.json'],
  ['has no argument list', 'noArgumentList.json'],
  ['names another pane', 'wrongPaneId.json'],
])('leaves a new pane alone when its process info %s', async (_name, reply) => {
  seedWorker('pane');
  fake.malformedEvidence(terminalId, 'processInfo', herdrReply(reply));

  const outcome = await stop(lostReplyHandle(), client);

  expect(outcome.stopped).toBe(false);
  expect(closed()).toEqual([]);
});

it('reports an unlocated worker when no terminals were recorded before the launch', async () => {
  seedWorker('pane');

  const outcome = await stop(newHandle(), client);

  expect(outcome.stopped).toBe(false);
  expect(closed()).toEqual([]);
});

const heldPlacement = (afterGate?: () => void) => {
  const placement = new WorkerPlacement();
  const release = Promise.withResolvers<undefined>();

  const held = placement.close(async () => {
    await release.promise;
    afterGate?.();
  });

  return {
    placement,
    held,
    release: () => {
      release.resolve(undefined);
    },
  };
};

it('does not wait for the placement queue when no worker was ever started', async () => {
  const { placement, held, release } = heldPlacement();
  const handle = newHandle();

  handle.startup.neverStarted = true;

  const outcome = stop(handle, client, { placement });

  expect(await outcome).toMatchObject({ stopped: true });
  release();
  await held;
});

it('does not wait for the placement queue when the worker terminal is known', async () => {
  vi.spyOn(cancellation, 'processAbsent').mockReturnValue(true);
  const { placement, held, release } = heldPlacement();

  const outcome = stop(ownedHandle(), client, { placement });

  expect(await outcome).toMatchObject({ stopped: true });
  release();
  await held;
});

it('waits for an in-flight launch to record its pane before it stops the worker', async () => {
  seedWorker('pane');
  const handle = newHandle();

  // The in-flight launch records its pane when its placement step finishes.
  const { placement, held, release } = heldPlacement(() => {
    handle.identity.paneId = 'pane';
  });

  const outcome = stop(handle, client, { placement });

  release();
  await held;

  expect(await outcome).toMatchObject({ stopped: true });
  expect(closed()).toEqual([['pane', 'close', 'pane']]);
});

it('keeps an owned worker alive through its grace period, then closes its pane', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const started = performance.now();
  let closedAt = 0;

  seedWorker('pane');

  const call = async (argumentsList: string[]) => {
    if (argumentsList[1] === 'close') {
      closedAt = performance.now() - started;
    }

    return client(argumentsList);
  };

  const stopping = stop(ownedHandle(), call, { graceful: true });

  await vi.advanceTimersByTimeAsync(2000);
  const outcome = await stopping;

  expect(outcome.stopped).toBe(true);
  expect(closedAt).toBeGreaterThanOrEqual(1000);
});

it('does not close the pane of a worker that exits during its grace period', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  seedWorker('pane');

  const call = async (argumentsList: string[]) => {
    // The worker exits when the second poll starts.
    if (fake.calls.some((entry) => entry[1] === 'list')) {
      fake.exit(terminalId);
    }

    return client(argumentsList);
  };

  const stopping = stop(ownedHandle(), call, { graceful: true });

  await vi.advanceTimersByTimeAsync(2000);
  const outcome = await stopping;

  expect(outcome.stopped).toBe(true);
  expect(closed()).toEqual([]);
});

it('confirms a closed worker whose process lingers briefly after its pane is gone', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  let checksAfterClose = 0;

  seedWorker('pane');

  vi.spyOn(cancellation, 'processAbsent').mockImplementation(() => {
    if (closed().length === 0) {
      return false;
    }

    checksAfterClose += 1;

    return checksAfterClose > 3;
  });

  const stopping = stop(ownedHandle(), client);

  await vi.advanceTimersByTimeAsync(1000);
  const outcome = await stopping;

  expect(outcome.stopped).toBe(true);
  expect(closed()).toEqual([['pane', 'close', 'pane']]);
});

it('reports a vanished pane whose process still runs as needing manual cleanup', async () => {
  const outcome = await stop(ownedHandle(), client);

  expect(outcome.stopped).toBe(false);
  expect(closed()).toEqual([]);
});

it('confirms a worker that exits while its identity is checked', async () => {
  seedWorker('pane');

  const call = async (argumentsList: string[]) => {
    if (argumentsList[1] === 'process-info') {
      fake.exit(terminalId);
      throw new Error('process-info failed');
    }

    return client(argumentsList);
  };

  const outcome = await stop(ownedHandle(), call);

  expect(outcome.stopped).toBe(true);
  expect(closed()).toEqual([]);
});

it('stops waiting for the grace period when the stop is aborted', async () => {
  const abort = new AbortController();
  let listings = 0;

  seedWorker('pane');

  const call = async (argumentsList: string[]) => {
    if (argumentsList[1] === 'list') {
      listings += 1;
      abort.abort();
    }

    return client(argumentsList);
  };

  const outcome = await stop(unownedHandle(), call, {
    graceful: true,
    signal: abort.signal,
  });

  expect(outcome.stopped).toBe(false);
  expect(listings).toBe(1);
  expect(closed()).toEqual([]);
});
